import { afterEach, describe, expect, test } from "bun:test";
import AdmZip from "adm-zip";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { unpackArchive, unpackTarGz, unpackZip } from "./archive";

/**
 * The in-process archive reader, against synthetic archives built here and
 * against the real pinned ones when they are on disk.
 *
 * Two halves on purpose, because neither is sufficient:
 *
 *   - SYNTHETIC always runs and is the only way to test the hostile shapes.
 *     Nothing upstream ships an entry named `../evil`, so a real-archive test
 *     can never prove the containment check fires — it would pass against a
 *     reader with no check at all.
 *   - REAL archives are the only thing that proves the reader understands what
 *     upstream actually publishes. A fixture written here could only prove this
 *     file agrees with itself about the tar format, and the whole risk of
 *     hand-writing a reader is a format detail nobody modelled.
 *
 * The real half is SKIPPED, loudly, when `server/.cache` has not been
 * populated by `scripts/vendor-local-engine.ts` — it holds ~100 MB of upstream
 * archives and is gitignored. A skip prints what to run; it does not pass
 * quietly.
 */

const CACHE = resolve(import.meta.dir, "..", ".cache");

let scratch: string | null = null;

function temp(): string {
  scratch = mkdtempSync(join(tmpdir(), "tradio-archive-"));
  return scratch;
}

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

// ── Building a real ustar stream, so the fixtures are genuinely valid ────────

interface Entry {
  name: string;
  body?: string;
  /** "0" file, "5" dir, "2" symlink, or anything else to test the refusal. */
  type?: string;
  mode?: number;
  link?: string;
}

/**
 * One 512-byte ustar header plus its padded data.
 *
 * The checksum is computed properly rather than left blank. The reader under
 * test ignores it, so a wrong one would go unnoticed here — but then these
 * fixtures would not be openable by `tar`, and a fixture that only this file
 * can read is how a reader gets tested against a format nobody else agrees
 * with. `tarIsReadableBySystemTar` below depends on it.
 */
function header(entry: Entry): Buffer {
  const block = Buffer.alloc(512, 0);
  const mode = entry.mode ?? 0o644;
  const body = entry.body ?? "";
  const size = entry.type === "5" || entry.type === "2" ? 0 : Buffer.byteLength(body);

  block.write(entry.name, 0, 100, "utf8");
  block.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8, "ascii");
  block.write("0000000\0", 108, 8, "ascii"); // uid
  block.write("0000000\0", 116, 8, "ascii"); // gid
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  block.write("00000000000\0", 136, 12, "ascii"); // mtime
  block.write("        ", 148, 8, "ascii"); // checksum: spaces while summing
  block.write(entry.type ?? "0", 156, 1, "ascii");
  if (entry.link) block.write(entry.link, 157, 100, "utf8");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");

  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");

  if (size === 0) return block;
  const padded = Buffer.alloc(Math.ceil(size / 512) * 512, 0);
  padded.write(body, 0, "utf8");
  return Buffer.concat([block, padded]);
}

function buildTarGz(entries: Entry[]): Buffer {
  return gzipSync(
    Buffer.concat([...entries.map(header), Buffer.alloc(1024, 0)])
  );
}

function writeTarGz(dir: string, entries: Entry[]): string {
  const path = join(dir, "fixture.tar.gz");
  writeFileSync(path, buildTarGz(entries));
  return path;
}

function writeZip(dir: string, files: { name: string; body: string }[]): string {
  const zip = new AdmZip();
  for (const f of files) zip.addFile(f.name, Buffer.from(f.body));
  const path = join(dir, "fixture.zip");
  zip.writeZip(path);
  return path;
}

/**
 * A zip built from raw bytes, because `adm-zip`'s WRITER cannot express the
 * attack.
 *
 * Measured: `zip.addFile("../../evil.txt")` stores the entry as `evil.txt` —
 * adm-zip normalises the name on the way in. So a hostile fixture built with it
 * is not hostile, and a containment test written against one would pass against
 * a reader that had no containment check at all. Its READER does not normalise,
 * which is the asymmetry that matters: a zip from upstream can carry any name.
 *
 * Stored (method 0) so there is no compressor to agree with — just the local
 * header, the central directory and the end record.
 */
function writeRawZip(dir: string, files: { name: string; body: string }[]): string {
  const { crc32 } = require("node:zlib") as { crc32: (data: Buffer) => number };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const body = Buffer.from(file.body, "utf8");
    const crc = crc32(body);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10); // stored
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + body.length;
  }

  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);

  const path = join(dir, "raw.zip");
  writeFileSync(path, Buffer.concat([...locals, centralBytes, end]));
  return path;
}

// ── The shapes that actually occur upstream ─────────────────────────────────

describe("unpackTarGz — the shapes the pinned archives contain", () => {
  test("files, directories and a sibling symlink, with --strip-components", () => {
    const dir = temp();
    const archive = writeTarGz(dir, [
      { name: "llama/", type: "5", mode: 0o755 },
      { name: "llama/llama-server", body: "ELF", mode: 0o755 },
      { name: "llama/libggml.so.0.24.0", body: "SO", mode: 0o644 },
      { name: "llama/libggml.so.0", type: "2", link: "libggml.so.0.24.0" },
      { name: "llama/lib/", type: "5", mode: 0o755 },
      { name: "llama/lib/ld-linux-x86-64.so.2", body: "LOADER", mode: 0o755 },
    ]);
    const out = join(dir, "out");

    const result = unpackTarGz(archive, out, 1);

    // dirs is 1, not 2: `llama/` is consumed entirely by --strip-components, so
    // the only directory CREATED is `lib/`. Measured, not assumed — the
    // expectation here was 2 first and the extraction was right.
    expect(result).toEqual({ files: 3, dirs: 1, linkCopies: 1 });
    expect(readFileSync(join(out, "llama-server"), "utf8")).toBe("ELF");
    expect(readFileSync(join(out, "lib", "ld-linux-x86-64.so.2"), "utf8")).toBe("LOADER");
    // The top-level `llama/` wrapper is consumed by strip, not recreated inside.
    expect(existsSync(join(out, "llama"))).toBe(false);
  });

  test("a symlink entry becomes a real file, NOT a link", () => {
    // Inverted on 2026-10-24, and the old assertion is the bug. This test used to
    // require `lstatSync(link).isSymbolicLink()`, which is exactly what FiveM's node
    // sandbox refuses to create — so it passed here under plain Bun and the unpack
    // died on every customer's Linux box. See the link pass in archive.ts.
    //
    // What has to be true is only what the dynamic linker needs: a thing with this
    // NAME whose bytes are the real library's. `DT_NEEDED` is resolved by filename.
    const dir = temp();
    const archive = writeTarGz(dir, [
      { name: "x/libggml.so.0.24.0", body: "REAL" },
      { name: "x/libggml.so.0", type: "2", link: "libggml.so.0.24.0" },
    ]);
    const out = join(dir, "out");

    const result = unpackTarGz(archive, out, 1);

    const link = join(out, "libggml.so.0");
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(lstatSync(link).isFile()).toBe(true);
    expect(readFileSync(link, "utf8")).toBe("REAL");
    // Counted as a link entry, not as a file, so the install log keeps saying how
    // many of the extracted names are duplicates.
    expect(result.linkCopies).toBe(1);
    expect(result.files).toBe(1);
  });

  test("a two-hop chain declared out of order resolves to the real file", () => {
    // The shape in the real archives: `libmtmd.so` -> `libmtmd.so.0` ->
    // `libmtmd.so.0.4.1`, with the FIRST link declared before its intermediate. A
    // naive "copy the named sibling off disk" reads a path that is still only a
    // pending link entry and fails, which is why the pass walks the link table.
    const dir = temp();
    const archive = writeTarGz(dir, [
      { name: "x/libmtmd.so", type: "2", link: "libmtmd.so.0" },
      { name: "x/libmtmd.so.0", type: "2", link: "libmtmd.so.0.4.1" },
      { name: "x/libmtmd.so.0.4.1", body: "MTMD" },
    ]);
    const out = join(dir, "out");

    const result = unpackTarGz(archive, out, 1);

    expect(readFileSync(join(out, "libmtmd.so"), "utf8")).toBe("MTMD");
    expect(readFileSync(join(out, "libmtmd.so.0"), "utf8")).toBe("MTMD");
    expect(result.linkCopies).toBe(2);
  });

  test("a link to a name no entry wrote is refused, not left dangling", () => {
    const dir = temp();
    const archive = writeTarGz(dir, [
      { name: "x/real", body: "ELF" },
      { name: "x/libghost.so.1", type: "2", link: "libghost.so.1.0.0" },
    ]);

    expect(() => unpackTarGz(archive, join(dir, "out"), 1)).toThrow(/no entry in the archive wrote/);
  });

  test("a symlink cycle is refused rather than followed forever", () => {
    const dir = temp();
    const archive = writeTarGz(dir, [
      { name: "x/a.so", type: "2", link: "b.so" },
      { name: "x/b.so", type: "2", link: "a.so" },
    ]);

    expect(() => unpackTarGz(archive, join(dir, "out"), 1)).toThrow(/does not terminate/);
  });

  test.skipIf(process.platform === "win32")(
    "the executable bit survives, and setuid does not",
    () => {
      // Two assertions in one case because they are the same field. 0755 is what
      // execve needs; setuid on a freshly downloaded binary is not something to
      // honour because an archive header asked for it.
      const dir = temp();
      const archive = writeTarGz(dir, [
        { name: "x/llama-server", body: "ELF", mode: 0o755 },
        { name: "x/data.bin", body: "D", mode: 0o644 },
        { name: "x/nasty", body: "N", mode: 0o4755 },
      ]);
      const out = join(dir, "out");

      unpackTarGz(archive, out, 1);

      expect(statSync(join(out, "llama-server")).mode & 0o777).toBe(0o755);
      expect(statSync(join(out, "data.bin")).mode & 0o777).toBe(0o644);
      const nasty = statSync(join(out, "nasty")).mode;
      expect(nasty & 0o777).toBe(0o755);
      expect(nasty & 0o4000).toBe(0);
    }
  );

  test("an entry whose name survives strip but has no parent dir entry is still written", () => {
    // tar archives do not have to declare a directory before a file inside it,
    // and piper's does not for every level. A reader relying on the dir entry
    // existing first would throw ENOENT on a real archive.
    const dir = temp();
    const archive = writeTarGz(dir, [{ name: "x/a/b/c/deep.txt", body: "DEEP" }]);
    const out = join(dir, "out");

    unpackTarGz(archive, out, 1);

    expect(readFileSync(join(out, "a", "b", "c", "deep.txt"), "utf8")).toBe("DEEP");
  });
});

// ── The hostile shapes, which no upstream archive contains ─────────────────

describe("unpackTarGz — refusals", () => {
  const dir = () => temp();

  test("an entry that escapes the destination is refused", () => {
    const d = dir();
    const archive = writeTarGz(d, [{ name: "x/../../evil.txt", body: "PWN" }]);
    expect(() => unpackTarGz(archive, join(d, "out"), 1)).toThrow(
      /resolves outside the extraction directory/
    );
    expect(existsSync(join(d, "evil.txt"))).toBe(false);
  });

  test("an absolute entry name lands inside the destination, not at its root", () => {
    // NOT a throw, and that is correct rather than a concession: the leading
    // separator is dropped, so `/etc/evil.txt` becomes `etc/evil.txt` INSIDE
    // the destination. GNU tar does the same thing and says so
    // ("Removing leading / from member names"). What matters is the measured
    // outcome — nothing is written outside — so that is what is asserted.
    const d = dir();
    const archive = writeTarGz(d, [{ name: "/etc/evil.txt", body: "PWN" }]);
    const out = join(d, "out");

    expect(unpackTarGz(archive, out, 0).files).toBe(1);
    expect(existsSync(join(out, "etc", "evil.txt"))).toBe(true);
    expect(existsSync("/etc/evil.txt")).toBe(false);
  });

  test("a symlink pointing out with .. is refused", () => {
    const d = dir();
    const archive = writeTarGz(d, [{ name: "x/esc", type: "2", link: "../../../etc/passwd" }]);
    expect(() => unpackTarGz(archive, join(d, "out"), 1)).toThrow(/is not a sibling/);
  });

  test("an absolute symlink target is refused", () => {
    const d = dir();
    const archive = writeTarGz(d, [{ name: "x/esc", type: "2", link: "/etc/passwd" }]);
    expect(() => unpackTarGz(archive, join(d, "out"), 1)).toThrow(/is not a sibling/);
  });

  test("a symlink into a subdirectory is refused even though it stays inside", () => {
    // Stricter than containment on purpose. `lib/real.so` resolves inside the
    // root, so a containment-only check would allow it — and then the reader is
    // trusting `path.resolve`, which is lexical, to describe a filesystem that
    // has symlinks in it. Every real target is a single component, so requiring
    // that costs nothing and removes the whole class.
    const d = dir();
    const archive = writeTarGz(d, [{ name: "x/link", type: "2", link: "lib/real.so" }]);
    expect(() => unpackTarGz(archive, join(d, "out"), 1)).toThrow(/is not a sibling/);
  });

  test("the write-through sequence is refused outright", () => {
    // Entry A links to a sibling directory, entry B writes through it. Both
    // entries are individually contained, so neither rule above rejects them —
    // this is the ordering, and nothing else, doing the work. If writes and
    // links were interleaved, B would be written into `real/` via `alias`.
    const d = dir();
    const archive = writeTarGz(d, [
      { name: "x/real/", type: "5", mode: 0o755 },
      { name: "x/alias", type: "2", link: "real" },
      { name: "x/alias/through.txt", body: "WROTE THROUGH" },
    ]);
    const out = join(d, "out");

    expect(() => unpackTarGz(archive, out, 1)).toThrow(
      /declared as a symlink and also written as a file or directory/
    );
    // The point of the ordering: nothing was written through the link, because
    // the link never existed while writes were happening.
    expect(existsSync(join(out, "real", "through.txt"))).toBe(false);
  });

  test("an unimplemented tar type is refused rather than skipped", () => {
    // "1" is a hardlink. Skipping it would extract an archive that is missing a
    // file the engine needs, and report success.
    const d = dir();
    const archive = writeTarGz(d, [{ name: "x/hard", type: "1", link: "other" }]);
    expect(() => unpackTarGz(archive, join(d, "out"), 1)).toThrow(
      /tar type "1", which this reader does not implement/
    );
  });
});

describe("unpackZip", () => {
  test("extracts with strip, and refuses an escaping entry", () => {
    const d = temp();
    const good = writeZip(d, [
      { name: "llama/llama-server.exe", body: "PE" },
      { name: "llama/ggml.dll", body: "DLL" },
    ]);
    const out = join(d, "out");
    const result = unpackZip(good, out, 1);
    expect(result.files).toBe(2);
    expect(readFileSync(join(out, "llama-server.exe"), "utf8")).toBe("PE");

    // Raw bytes, not adm-zip's writer, which normalises the name away — see
    // writeRawZip. Without that the assertion below would be decorative.
    const evil = writeRawZip(d, [{ name: "../../evil.txt", body: "PWN" }]);
    expect(() => unpackZip(evil, join(d, "out2"), 0)).toThrow(
      /resolves outside the extraction directory/
    );
    expect(existsSync(join(d, "evil.txt"))).toBe(false);
  });

  test("CONTROL: the raw-zip builder produces something the reader accepts", () => {
    // Without this, the refusal above could be passing because the handcrafted
    // zip is malformed and adm-zip throws on ANY raw zip — which would make the
    // containment assertion prove nothing about containment.
    const d = temp();
    const fine = writeRawZip(d, [{ name: "llama/ggml.dll", body: "DLL" }]);
    const out = join(d, "out");
    expect(unpackZip(fine, out, 1).files).toBe(1);
    expect(readFileSync(join(out, "ggml.dll"), "utf8")).toBe("DLL");
  });
});

describe("unpackArchive — dispatch", () => {
  test("an unknown extension is refused, not guessed at", () => {
    const d = temp();
    const path = join(d, "engine.7z");
    writeFileSync(path, "x");
    expect(() => unpackArchive(path, join(d, "out"), 0)).toThrow(/not a \.zip or \.tar\.gz/);
  });
});

// ── Against the real pinned archives ───────────────────────────────────────

/**
 * `tar -tv` as the oracle, which is the point of this half: the counts and the
 * path set come from the system tar, not from an expectation written by hand.
 */
/**
 * Windows' own bsdtar, by full path — the same resolution
 * `scripts/vendor-local-engine.ts` documents and for the same reason. Bare
 * `tar` on this machine is Git's MSYS build, which rewrites Windows paths in
 * its arguments and fails to open the archive at all. Measured: `tar -tvf
 * C:/.../llama-linux.tar.gz` fails where the System32 copy lists it fine.
 */
const TAR =
  process.platform === "win32" && existsSync("C:\\Windows\\System32\\tar.exe")
    ? "C:\\Windows\\System32\\tar.exe"
    : "tar";

function tarListing(archive: string): { paths: Set<string>; links: number; files: number } {
  const text = execFileSync(TAR, ["-tvf", archive], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const paths = new Set<string>();
  let links = 0;
  let files = 0;
  // `\r?\n`: bsdtar on Windows terminates its listing lines with CRLF, and a
  // trailing \r silently becomes part of the last path.
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const kind = line[0];
    // bsdtar: mode, links, owner, group, size, month, day, time, name.
    // EIGHT fields before the name, not five — measured, after a parser that
    // assumed five reported 52 of llama's files "missing" when every one was
    // on disk. Symlink lines append " -> target", stripped first.
    const name = line.replace(/ -> .*$/, "").trim().split(/\s+/).slice(8).join(" ");
    if (name === "") continue;
    const relative = name.replace(/\/$/, "").split("/").slice(1).join("/");
    if (relative === "") continue;
    if (kind === "l") links++;
    else if (kind === "-") {
      files++;
      paths.add(relative);
    }
  }
  return { paths, links, files };
}

const REAL = [
  { id: "llama-linux", file: "llama-linux.tar.gz", expect: "llama-server" },
  { id: "whisper-linux", file: "whisper-linux.tar.gz", expect: "whisper-server" },
  { id: "piper-linux", file: "piper-linux.tar.gz", expect: "piper" },
];

describe("the real pinned tarballs, against system tar", () => {
  for (const archive of REAL) {
    const path = join(CACHE, archive.file);
    const present = existsSync(path);

    test.skipIf(!present)(`${archive.id} extracts exactly what tar lists`, () => {
      const out = join(temp(), "out");
      const result = unpackTarGz(path, out, 1);
      const oracle = tarListing(path);

      // Counts first: a reader that silently skipped a whole entry type would
      // still produce a plausible tree.
      expect(result.files).toBe(oracle.files);
      expect(result.linkCopies).toBe(oracle.links);

      // Then every regular file tar named is on disk, by path.
      const missing = [...oracle.paths].filter((rel) => !existsSync(join(out, rel)));
      expect(missing).toEqual([]);

      // And the binary the launcher resolves is actually there — `binDir` in
      // local-engine.ts joins server/bin/<platform>/<engine>, so this path is
      // the contract between the installer and the launcher.
      expect(existsSync(join(out, archive.expect))).toBe(true);
    });
  }

  test("the real archives were available to test against", () => {
    // VACUITY FLOOR. Every case above is skipIf, so with an unpopulated cache
    // this whole describe is green while having read no real archive at all.
    // This does not fail the suite — the cache is gitignored and a bare clone
    // legitimately lacks it — but it says so out loud instead of passing
    // silently. See `tradio-suite-needs-gitignored-dev-content`.
    const found = REAL.filter((a) => existsSync(join(CACHE, a.file)));
    if (found.length !== REAL.length) {
      console.warn(
        `\n  ⚠️ archive.test.ts: ${found.length}/${REAL.length} real archives present in ` +
          `server/.cache.\n     The reader was tested against synthetic fixtures ONLY.\n` +
          "     Run `bun run scripts/vendor-local-engine.ts` to populate it.\n"
      );
    }
    expect(found.length).toBeGreaterThanOrEqual(0);
  });
});
