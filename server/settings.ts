import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { SettingsView } from "../shared/types";
import { DATA_DIR, DEFAULT_MODEL } from "./config";

interface StoredSettings {
  companyName: string;
  apiKey?: string;
  managerModel: string;
  workerModel: string;
}

const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

let settings: StoredSettings = {
  companyName: "Siverse Inc.",
  managerModel: DEFAULT_MODEL,
  workerModel: DEFAULT_MODEL,
};
let client: Anthropic | null = null;

export function loadSettings() {
  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) };
  } catch {
    // First run.
  }
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 0600: the file can hold the API key, so only the current user may read it.
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), { mode: 0o600 });
}

export function getSettings(): Readonly<StoredSettings> {
  return settings;
}

export function updateSettings(patch: Partial<StoredSettings>) {
  const next = { ...settings };
  if (patch.companyName !== undefined) next.companyName = patch.companyName.trim().slice(0, 60) || settings.companyName;
  if (patch.managerModel) next.managerModel = patch.managerModel.trim();
  if (patch.workerModel) next.workerModel = patch.workerModel.trim();
  if (patch.apiKey !== undefined) {
    const key = patch.apiKey.trim();
    if (key) next.apiKey = key;
    else delete next.apiKey;
    client = null;
  }
  settings = next;
  save();
}

function envKey() {
  return process.env.ANTHROPIC_API_KEY?.trim() || null;
}

export function settingsView(): SettingsView {
  const key = settings.apiKey ?? envKey();
  return {
    companyName: settings.companyName,
    apiKeySource: settings.apiKey ? "settings" : envKey() ? "env" : null,
    apiKeyHint: key ? key.slice(-4) : null,
    managerModel: settings.managerModel,
    workerModel: settings.workerModel,
  };
}

/** Returns a client, or null when no API key is configured yet. */
export function getClient(): Anthropic | null {
  if (client) return client;
  if (settings.apiKey) client = new Anthropic({ apiKey: settings.apiKey });
  else if (envKey()) client = new Anthropic();
  return client;
}
