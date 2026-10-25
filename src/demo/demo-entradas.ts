/**
 * `/demo-entradas` browser entrypoint.
 *
 * A separate Vite input from `/entradas`, so the demo's styles and code never ship to (or run on)
 * the real ticket page. It imports no purchase module: the page can only ever show a summary.
 */

import "../styles/main.css";
import "../styles/demo-entradas.css";
import { DEMO_ROOT_ID, mountDemoPage } from "./page.ts";

const root = document.getElementById(DEMO_ROOT_ID);
if (root !== null) {
  mountDemoPage(root, document);
}
