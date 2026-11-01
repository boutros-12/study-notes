import handler from "../../api/sync.js";
import { adapt } from "../lib/adapter.js";

export default adapt(handler);
export const config = { path: "/api/sync" };
