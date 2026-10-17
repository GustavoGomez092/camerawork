import { PATTERN_STYLES } from "../src/backdrops/styles/pattern.js";
import { describeStyle } from "./style-helpers.js";

for (const [name, style] of Object.entries(PATTERN_STYLES)) describeStyle(name, style);
