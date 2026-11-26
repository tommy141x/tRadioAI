/**
 * The notices audit's negative control: `bun run notices:check:control`.
 *
 * Requires the audit to accept a correct document, then plants each defect it exists
 * to catch and requires it to fail by name. An audit that passes on a document with a
 * bundled package missing from it is measuring nothing.
 *
 * Runs on synthetic components rather than the real graph, so it needs no build and
 * cannot start passing because the real document happens to be right.
 */

import {
  type Component,
  componentMarker,
  noticesProblems,
  render,
} from "../third-party-notices.ts";

const GRANT =
  "Permission is hereby granted, free of charge, to any person obtaining a copy of this software";

function component(name: string, version: string): Component {
  return {
    name,
    version,
    spdx: "MIT",
    textSource: `${name}/LICENSE as published on npm`,
    text: `MIT License\n\nCopyright (c) ${name} authors\n\n${GRANT}, and to do as they wish with it.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.`,
  };
}

const components = [component("alpha-pkg", "1.0.0"), component("beta-pkg", "2.3.4")];
const good = render(components, 60, "2026-11-25");

const cases: Array<[string, string | null, Component[], RegExp]> = [
  [
    "the document is missing entirely",
    null,
    components,
    /missing — the bundle ships with no attribution/,
  ],
  [
    "a bundled package is not in the document",
    render([components[0]], 60, "2026-11-25"),
    components,
    /beta-pkg@2\.3\.4 is bundled but not attributed/,
  ],
  [
    "a package is listed at the wrong version",
    good,
    [components[0], component("beta-pkg", "2.3.5")],
    /beta-pkg@2\.3\.5 is bundled but not attributed/,
  ],
  [
    "a heading with no licence text under it",
    good.split(GRANT).join("(text removed)"),
    components,
    /its licence text is not/,
  ],
  ["the derivation measured nothing", good, [], /produced NO components/],
];

const failures: string[] = [];

const baseline = noticesProblems(good, components);
if (baseline.length > 0) {
  failures.push(`a correct document was refused: ${baseline.join("; ")}`);
}

// The marker is the audit's whole handle on a component. If it ever stops appearing
// in the rendered document, every case above goes green for the wrong reason.
for (const one of components) {
  if (!good.includes(componentMarker(one))) {
    failures.push(`render() does not emit the marker the audit looks for (${one.name})`);
  }
}

for (const [label, staged, derived, expected] of cases) {
  const problems = noticesProblems(staged, derived);
  if (problems.length === 0) failures.push(`${label}: the audit accepted it`);
  else if (!problems.some((problem) => expected.test(problem))) {
    failures.push(`${label}: refused, but not for the right reason (${problems.join("; ")})`);
  } else {
    console.log(`  caught as required  ${label}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL  ${failure}`);
  process.exit(1);
}
console.log("PASS  the notices audit is demonstrably capable of failing.");
