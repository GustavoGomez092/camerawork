import { CLASSIC_STYLES } from "../src/backdrops/styles/classic.js";
import { describeStyle } from "./style-helpers.js";

for (const [name, style] of Object.entries(CLASSIC_STYLES)) describeStyle(name, style);
