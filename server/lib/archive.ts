/**
 * Unpack a pinned engine archive, in-process.
 *
 * The local inference engines are published by their upstreams as 3 zip and 3
 * tar.gz, and nothing is mirrored: this project does not host third-party bytes.
 * So the resource fetches the upstream archive and has to open it itself.
 *
 * ## Why this is not a spawn of `tar`
 *
 * `tar -xf` is what `scripts/vendor-local-engine.ts` uses at build time and it
 * handles everything here for free. It is unavailable at runtime on purpose:
 * tLib's spawn gate requires the binary it execs to be "absolute, realpath'd,
 * proven inside the caller's resource directory", which is the whole of what
 * stops path smuggling, and `/usr/bin/tar` is outside. A second validation path
 * beside that rule would be a second thing to get wrong on the one check that
 * must not be wrong. It also drops a dependency on `tar` existing on the host.
 *
 * ## Why a hand-written reader is safe here, measured rather than assumed
 *
 * The required feature set was inventoried across all three real tarballs
 * (`tar -tv` as the oracle) before a line of this was written:
 *
 *   typeflags present   regular, directory, symlink — ONLY these three.
 *                       no hardlinks, no GNU long names, no pax headers
 *   longest path        30 chars, against ustar's 100-byte name field, so the
 *                       `prefix` field is never populated (it is still read)
 *   symlinks            23 in total, EVERY target a relative single component
 *                       naming a sibling: libggml.so.0 -> libggml.so.0.24.0
 *   modes               51 files at 0755, the rest 0644
 *
 * Anything outside that set is refused rather than guessed at. An archive that
 * needs a feature this does not implement fails loudly at install, which is
 * recoverable; one that is silently half-extracted is not.
 *
 * ## The three things that make this safe against a hostile archive
 *
 * An upstream archive is untrusted input, and the inventory above describes
 * TODAY's tarball, not tomorrow's. All three defences are enforced even though
 * nothing currently violates them:
 *
 *   1. **Lexical containment.** Every entry's resolved destination must be
 *      inside the extraction root. Catches an absolute name and any `..`.
 *   2. **Symlink targets are single components.** Not merely "no `..`": the
 *      target may not be absolute and may not contain a separator at all. A
 *      sibling link inside the root can only ever resolve inside the root, so
 *      link chains cannot walk out even though `path.resolve` is lexical and
 *      would not notice if they did. This is now load-bearing twice: it is also
 *      what makes the chain walk in the link pass closed and terminating.
 *   3. **Link entries are applied LAST**, after every regular write. This is what
 *      closes the write-through hole that (1) and (2) cannot: entry A a link to
 *      a directory, entry B writing through it. If no entry is written after
 *      any link exists, the sequence has nowhere to land. It is also what lets
 *      the link pass resolve a chain by reading from disk — by then every regular
 *      file the archive declared is already there.
 *
 * Note that symlink entries are materialised as COPIES, not as links: FiveM's
 * node sandbox refuses symlink creation. The full reasoning, and the error it
 * produced on every Linux host, is on the link pass in `unpackTarGz`.
 *
 * Mode bits come from the header masked to `0o755`, which keeps the executable
 * bit that the dynamic loader and `execve` need and discards setuid, setgid and
 * sticky rather than honouring them from a downloaded file.
 *
 * ⚠️ The CALLER verifies the archive's sha256 before calling this. Nothing here
 * re-checks it, and nothing here should start reading entries out of unverified
 * bytes — see `ensureEngines`.
 */

import AdmZip from "adm-zip";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

/** What came out, so a caller can say "49 files" rather than "ok". */
export interface UnpackResult {
  files: number;
  dirs: number;
  /**
   * Symlink entries, each materialised as a COPY of the file it resolves to rather
   * than as a link — see the note on the link pass in `unpackTarGz`. Counted
   * separately from `files` because they are link entries in the archive, and
   * because the difference is what the extra ~51 MB on disk buys.
   */
  linkCopies: number;
}

/** A tar entry this reader understands. Anything else is refused. */
const TAR_TYPE = { file: "0", fileAlt: "\0", dir: "5", symlink: "2" } as const;

const TAR_BLOCK = 512;

/**
 * One entry's absolute destination, proven inside the root.
 *
 * `resolve` is purely lexical, which is exactly what is wanted for this check:
 * it must not be deflected by anything already on disk. The symlink rules above
 * are what make the lexical answer the true one.
 */
function containedPath(root: string, relative: string, archive: string): string {
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(
      `${archive}: entry "${relative}" resolves outside the extraction directory. ` +
        "Refusing to unpack it.",
    );
  }
  return target;
}

/**
 * Drop `strip` leading path segments, the way `--strip-components` does.
 *
 * Returns null for an entry with nothing left, which `tar` also skips: the
 * archives wrap their payload in one top-level directory and that directory
 * itself becomes nothing.
 */
function stripped(name: string, strip: number): string | null {
  const parts = name.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length <= strip) return null;
  return parts.slice(strip).join("/");
}

/** A tar header's octal field. Trailing NULs and spaces, as the format allows. */
function octal(header: Buffer, offset: number, length: number): number {
  const text = header
    .toString("ascii", offset, offset + length)
    .replace(/[\0 ]+$/, "")
    .trim();
  if (text === "") return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value)) throw new Error(`unreadable octal field at offset ${offset}`);
  return value;
}

function assertSingleComponent(target: string, name: string, archive: string): void {
  if (target === "" || target === "." || target === "..") {
    throw new Error(`${archive}: symlink "${name}" has an unusable target "${target}".`);
  }
  if (target.includes("/") || target.includes("\\") || /^[A-Za-z]:/.test(target)) {
    throw new Error(
      `${archive}: symlink "${name}" points at "${target}", which is not a sibling. ` +
        "Only single-component symlink targets are accepted — every target in the pinned " +
        "archives is one, and anything else can walk out of the extraction directory.",
    );
  }
}

/**
 * Extract a gzipped ustar archive.
 *
 * The whole file is gunzipped into memory: the largest of the six is 26 MB, and
 * a streaming reader would be more code for a size that does not need it.
 */
export function unpackTarGz(archivePath: string, dest: string, strip: number): UnpackResult {
  const label = archivePath;
  const tar = gunzipSync(readFileSync(archivePath));
  const root = resolve(dest);
  const result: UnpackResult = { files: 0, dirs: 0, linkCopies: 0 };
  // Deferred so that no regular write happens after a link exists. See (3) above.
  const links: { path: string; target: string }[] = [];

  let offset = 0;
  while (offset + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK);
    // Two consecutive zero blocks end the archive; one is enough to stop on,
    // since a zero name is not a thing a real entry has.
    if (header.every((byte) => byte === 0)) break;

    const rawName = header.toString("utf8", 0, 100).replace(/\0.*$/, "");
    const prefix = header.toString("utf8", 345, 500).replace(/\0.*$/, "");
    const name = prefix === "" ? rawName : `${prefix}/${rawName}`;
    const mode = octal(header, 100, 8);
    const size = octal(header, 124, 12);
    const type = header.toString("ascii", 156, 157);
    const linkTarget = header.toString("utf8", 157, 257).replace(/\0.*$/, "");

    offset += TAR_BLOCK;
    const dataBlocks = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;

    const relative = stripped(name, strip);
    if (relative === null) {
      offset += dataBlocks;
      continue;
    }

    if (type === TAR_TYPE.dir) {
      mkdirSync(containedPath(root, relative, label), { recursive: true });
      result.dirs++;
    } else if (type === TAR_TYPE.file || type === TAR_TYPE.fileAlt) {
      const target = containedPath(root, relative, label);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, tar.subarray(offset, offset + size));
      // Keep the executable bit, discard setuid/setgid/sticky.
      chmodSync(target, mode & 0o755);
      result.files++;
    } else if (type === TAR_TYPE.symlink) {
      assertSingleComponent(linkTarget, relative, label);
      links.push({ path: containedPath(root, relative, label), target: linkTarget });
    } else {
      throw new Error(
        `${label}: entry "${name}" has tar type "${type}", which this reader does not ` +
          "implement. The pinned archives contain only files, directories and symlinks; " +
          "an upstream that started shipping hardlinks or pax headers needs this reader " +
          "extended rather than the entry skipped.",
      );
    }

    offset += dataBlocks;
  }

  // ── Why these are COPIES and not symlinks ──
  //
  // FiveM's node sandbox refuses symlink creation outright, and surfaces it as a
  // permission error on the TARGET rather than on the link. Node's `fs.symlink`
  // binding permission-checks its first argument verbatim and is the only one of
  // the two paths it does not normalise, so a single-component target like
  // `libmtmd.so.0` reaches the host as a bare relative name, is resolved against
  // the FXServer process CWD instead of this directory, matches no vfs device and
  // comes back as:
  //
  //   Filesystem permission check from 'tRadio' for permission fs.read on
  //   resource 'libmtmd.so.0' - no device found
  //   ERROR engines: llama-linux FAILED to unpack — Access to this API has been
  //   restricted. Use --allow-fs-read to manage permissions.
  //
  // ("resource" there is Node's own word for the path, not a FiveM resource name.)
  // Every regular write above succeeds on the same box; `symlinkSync` was the only
  // blocked call, and it took all three Linux engines down with it — text,
  // transcription and speech — so AI dispatching was 100% unavailable on every
  // Linux host while Windows was fine. No server.cfg line can change that:
  // `add_filesystem_permission`'s read arm is dead code in the runtime, and the
  // sandbox documentation says plainly that symlinks "cannot be followed or
  // created". Passing an absolute target would get past the check today, but
  // upstream Node already blocks `symlinkSync` outright under the permission model,
  // so that fix would have an expiry date at the next FXServer node rebase.
  //
  // A regular file under the link's name serves the dynamic linker exactly as well:
  // `DT_NEEDED` entries are resolved by filename. Costs ~51 MB across the three
  // Linux engines (~27 llama, ~20 piper, ~3.5 whisper).
  //
  // The chain is followed rather than copied from the named sibling, because these
  // archives contain two-hop chains — `libmtmd.so` -> `libmtmd.so.0` ->
  // `libmtmd.so.0.4.1` — and declare the first link BEFORE its intermediate, so a
  // naive sibling copy would read a path that is still only a pending link. Defence
  // (2), single-component targets, is what makes the walk closed and terminating:
  // every hop stays in the same directory.
  const pending = new Map(links.map((link) => [link.path, link.target]));
  for (const link of links) {
    // An occupied path here means the archive declared the same name as both a
    // symlink and something else — which is precisely the write-through
    // attempt: entry A links to a directory, entry B writes "through" it, and
    // because links are applied last B has already created A's name as a real
    // directory holding B's file. Refuse the archive rather than reconcile it.
    //
    // Deliberately NOT `rm -rf` on the way to forcing the link: that would
    // delete files just extracted, and would turn a hostile archive into a
    // deletion primitive aimed at whatever the link's name happens to be.
    if (existsSync(link.path)) {
      throw new Error(
        `${label}: "${link.path}" is declared as a symlink and also written as a file or ` +
          "directory by another entry. Refusing the archive: this is the shape a " +
          "write-through takes, and there is no correct way to honour both entries.",
      );
    }
    let final = resolve(dirname(link.path), link.target);
    for (let hop = 0; pending.has(final); hop++) {
      if (hop > links.length) {
        throw new Error(
          `${label}: the symlink chain starting at "${link.path}" does not terminate. ` +
            "A cycle cannot be materialised, and following it would not halt.",
        );
      }
      // biome-ignore lint/style/noNonNullAssertion: pending.has(final) checked by the loop condition
      final = resolve(dirname(final), pending.get(final)!);
    }
    if (!existsSync(final)) {
      throw new Error(
        `${label}: symlink "${link.path}" resolves to "${final}", which no entry in the ` +
          "archive wrote. Refusing rather than leaving behind a name the dynamic linker " +
          "would fail to load at the first transmission.",
      );
    }
    mkdirSync(dirname(link.path), { recursive: true });
    writeFileSync(link.path, readFileSync(final));
    // The copy must carry the executable bit for the same reason the original does.
    chmodSync(link.path, statSync(final).mode & 0o755);
    result.linkCopies++;
  }

  return result;
}

/**
 * Extract a zip.
 *
 * `adm-zip` is already a production dependency. The Windows archives need
 * neither symlinks nor mode bits — Windows has no executable bit and resolves
 * DLLs by name, and the inventory found no symlink entries in either zip — so
 * this is the simpler half. The containment check is identical: it is about the
 * archive being untrusted, not about the platform.
 */
export function unpackZip(archivePath: string, dest: string, strip: number): UnpackResult {
  const root = resolve(dest);
  const result: UnpackResult = { files: 0, dirs: 0, linkCopies: 0 };

  for (const entry of new AdmZip(archivePath).getEntries()) {
    const relative = stripped(entry.entryName, strip);
    if (relative === null) continue;
    const target = containedPath(root, relative, archivePath);

    if (entry.isDirectory) {
      mkdirSync(target, { recursive: true });
      result.dirs++;
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.getData());
    result.files++;
  }

  return result;
}

/**
 * Unpack by archive kind, chosen from the pinned URL's extension.
 *
 * The same decision `vendor-local-engine.ts` makes when it names the staged
 * file, and for the same reason: the lockfile pins a URL, and its extension is
 * the only statement anywhere about what the bytes are.
 */
export function unpackArchive(archivePath: string, dest: string, strip: number): UnpackResult {
  mkdirSync(dest, { recursive: true });
  if (archivePath.endsWith(".zip")) return unpackZip(archivePath, dest, strip);
  if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
    return unpackTarGz(archivePath, dest, strip);
  }
  throw new Error(
    `${archivePath}: not a .zip or .tar.gz. The pinned archives are one or the other; ` +
      "a new kind needs a reader, not a fallback.",
  );
}

/** A failed or half-finished unpack must not leave a directory that looks installed. */
export function discardUnpacked(dest: string): void {
  rmSync(dest, { recursive: true, force: true });
}
