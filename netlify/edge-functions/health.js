import handler from "../../api/health.js";
import { adapt } from "../lib/adapter.js";

export default adapt(handler);
export const config = { path: "/api/health" };
