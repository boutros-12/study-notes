import handler from "../../api/chat.js";
import { adapt } from "../lib/adapter.js";

export default adapt(handler);
export const config = { path: "/api/chat" };
