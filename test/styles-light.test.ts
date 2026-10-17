import { LIGHT_STYLES } from "../src/backdrops/styles/light.js";
import { describeStyle } from "./style-helpers.js";

for (const [name, style] of Object.entries(LIGHT_STYLES)) describeStyle(name, style);
