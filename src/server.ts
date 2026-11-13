#!/usr/bin/env node
// Tap over stdio, for one person on their own machine. Their status lives in TAP_STATE (default ~/.tap/state.json).
import { homedir } from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { makeServer } from "./tools.ts";

await makeServer(process.env.TAP_STATE ?? `${homedir()}/.tap/state.json`).connect(new StdioServerTransport());
