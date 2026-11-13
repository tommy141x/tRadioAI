/** Logger for every module in this resource. FiveM's console shows the tag, so it names the resource. */

// Must be set before consola is required so its colour-support check sees it.
process.env.FORCE_COLOR = "1";

const { createConsola } = require("consola");

const consola = createConsola({
  level: 3,
  fancy: true,
  formatOptions: { date: true, colors: true, compact: false },
});

export const aiLog = consola.withTag("tRadioAI");
