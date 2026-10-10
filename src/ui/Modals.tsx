import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  EFFORT_LEVELS,
  MAX_HEADCOUNT,
  MODEL_OPTIONS,
  WEEKDAYS,
  describeCadence,
  type AskFirst,
  type CommandView,
  type Department,
  type Effort,
  type Employee,
  type Schedule,
  type ScheduleCadence,
  type Snapshot,
  type Task,
} from "../../shared/types";
import { useDraft } from "../drafts";
import { chainFrom } from "../failures";
import { api, useStore } from "../store";
import { DriveMarkdown } from "./DriveMarkdown";

export function Modals({ snapshot }: { snapshot: Snapshot }) {
  const modal = useStore((s) => s.modal);
  if (!modal) return null;
  switch (modal.type) {
    case "settings":
      return <SettingsModal snapshot={snapshot} />;
    case "department": {
      const department = snapshot.departments.find((d) => d.id === modal.departmentId) ?? null;
      if (department?.source === "claude-code") return <ClaudeCodeProjectModal department={department} snapshot={snapshot} />;
      return (
        <DepartmentModal
          key={modal.departmentId ?? "new"}
          department={department}
          staff={snapshot.employees.filter((e) => e.departmentId === department?.id)}
          commands={snapshot.commands.filter((c) => c.departmentId === department?.id)}
          tasks={snapshot.tasks.filter((t) => t.departmentId === department?.id)}
          schedules={snapshot.schedules.filter((s) => s.departmentId === department?.id)}
        />
      );
    }
    case "drive":
      return <DriveModal />;
    case "file":
      return <FileModal path={modal.path} />;
  }
}

function Modal({ title, children, wide }: { title: string; children: ReactNode; wide?: boolean }) {
  const openModal = useStore((s) => s.openModal);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && openModal(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openModal]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && openModal(null)}>
      <div className={`modal${wide ? " modal--wide" : ""}`} role="dialog" aria-modal aria-label={title}>
        <header className="modal__header">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={() => openModal(null)} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="modal__body">{children}</div>
      </div>
    </div>
  );
}

const modelLabel = (id?: string) => MODEL_OPTIONS.find((m) => m.id === id)?.label.replace(/ \(.*\)$/, "") ?? id ?? "the worker model";

const EFFORT_LABELS: Record<Effort, string> = {
  low: "Low (quickest)",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max (most thorough)",
};

function ModelSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const known = MODEL_OPTIONS.some((m) => m.id === value);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {!known && <option value={value}>{value}</option>}
      {MODEL_OPTIONS.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
    </select>
  );
}

function SettingsModal({ snapshot }: { snapshot: Snapshot }) {
  const { settings } = snapshot;
  const openModal = useStore((s) => s.openModal);
  const showToast = useStore((s) => s.showToast);
  const [companyName, setCompanyName] = useState(settings.companyName);
  const [aiOffice, setAiOffice] = useState(settings.aiOffice);
  const [apiKey, setApiKey] = useState("");
  const [managerModel, setManagerModel] = useState(settings.managerModel);
  const [workerModel, setWorkerModel] = useState(settings.workerModel);
  const [engine, setEngine] = useState(settings.engine);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    await api("PUT", "/api/settings", {
      companyName,
      aiOffice,
      engine,
      managerModel,
      workerModel,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    });
    showToast("Settings saved.");
    openModal(null);
  };

  const removeKey = async () => {
    await api("PUT", "/api/settings", { apiKey: "" });
    showToast("Saved key removed.");
  };

  return (
    <Modal title="Settings">
      <form className="form" onSubmit={save}>
        <label>
          Company name
          <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} maxLength={60} />
        </label>

        <label className="checkbox toggle">
          <input type="checkbox" checked={aiOffice} onChange={(e) => setAiOffice(e.target.checked)} />
          <span>
            <strong>AI office</strong>
            <small>
              Siverse's own manager and workers, who take orders in the chat and do real work. Watching Claude Code
              doesn't need this.
            </small>
          </span>
        </label>

        {aiOffice && (
          <fieldset>
            <legend>Who does the work</legend>
            <label className="checkbox toggle">
              <input type="radio" name="engine" checked={engine === "claude-code"} onChange={() => setEngine("claude-code")} />
              <span>
                <strong>Claude Code on this computer</strong>
                <small>
                  Uses your Claude Pro/Max plan, with no API key. The manager and every worker run as Claude Code on this
                  computer, so they count towards your plan's usage limits. Siverse must stay running for schedules.
                </small>
              </span>
            </label>
            <label className="checkbox toggle">
              <input type="radio" name="engine" checked={engine === "api"} onChange={() => setEngine("api")} />
              <span>
                <strong>Claude API</strong>
                <small>Uses an API key from console.anthropic.com, billed per use, separately from Claude plans.</small>
              </span>
            </label>
            {engine === "claude-code" &&
              (settings.claudeCodeCli.path ? (
                <p className="hint ok tiny">
                  Found Claude Code {settings.claudeCodeCli.version} at <code>{settings.claudeCodeCli.path}</code>.
                </p>
              ) : (
                <p className="hint tiny">
                  Claude Code wasn't found. Install it (or the Claude desktop app), sign in once, then save again. You
                  can also point Siverse at it with <code>CLAUDE_CODE_BIN</code> in <code>.env</code>.
                </p>
              ))}
          </fieldset>
        )}

        {aiOffice && (
          <>
            {engine === "api" && (
            <fieldset>
              <legend>Claude API key</legend>
              {settings.apiKeySource === "env" && (
                <p className="hint ok">Using ANTHROPIC_API_KEY from the server environment (ends in …{settings.apiKeyHint}).</p>
              )}
              {settings.apiKeySource === "settings" && (
                <p className="hint ok">
                  A key ending in …{settings.apiKeyHint} is saved.{" "}
                  <button type="button" className="link" onClick={removeKey}>
                    Remove it
                  </button>
                </p>
              )}
              {!settings.apiKeySource && (
                <p className="hint">
                  The office needs a Claude API key to run. Create one at{" "}
                  <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
                    console.anthropic.com
                  </a>
                  . Usage is billed to your Anthropic account.
                </p>
              )}
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={settings.apiKeySource ? "Paste a new key to replace it" : "sk-ant-…"}
                autoComplete="off"
                spellCheck={false}
              />
              <p className="hint tiny">
                Stored only on this computer in <code>data/settings.json</code>. It is never sent back to the browser.
              </p>
            </fieldset>
            )}

            <div className="form__row">
              <label>
                Manager model
                <ModelSelect value={managerModel} onChange={setManagerModel} />
              </label>
              <label>
                Worker model
                <ModelSelect value={workerModel} onChange={setWorkerModel} />
              </label>
            </div>
            <p className="hint tiny">
              {engine === "claude-code"
                ? "Every running worker is its own Claude Code run. A lighter worker model makes your plan's usage go further."
                : "Every running worker is its own stream of API calls. A cheaper worker model lowers the cost of a busy office."}
            </p>
          </>
        )}

        <div className="form__actions">
          <button type="button" className="btn btn--ghost" onClick={() => openModal(null)}>
            Cancel
          </button>
          <button className="btn btn--primary" type="submit">
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DepartmentModal({
  department,
  staff,
  commands,
  tasks,
  schedules,
}: {
  department: Department | null;
  staff: Employee[];
  commands: CommandView[];
  tasks: Task[];
  schedules: Schedule[];
}) {
  const openModal = useStore((s) => s.openModal);
  const showToast = useStore((s) => s.showToast);
  const [name, setName] = useState(department?.name ?? "");
  const [genre, setGenre] = useState(department?.genre ?? "");
  const [description, setDescription] = useState(department?.description ?? "");
  const [headcount, setHeadcount] = useState(department?.headcount ?? 2);
  const [webAccess, setWebAccess] = useState(department?.webAccess ?? false);
  const [codeAccess, setCodeAccess] = useState(department?.codeAccess ?? false);
  const [model, setModel] = useState(department?.model ?? ""); // "" = office default
  const [effort, setEffort] = useState<Effort | "">(department?.effort ?? "");
  const settings = useStore((s) => s.snapshot?.settings);
  const [taskTitle, setTaskTitle, clearTaskTitle] = useDraft(department ? `task:${department.id}:title` : null);
  const [taskBrief, setTaskBrief, clearTaskBrief] = useDraft(department ? `task:${department.id}:brief` : null);
  const [taskEmployee, setTaskEmployee] = useState("");
  // Hiring can add a desk while this window is open; keep the field in step with the server.
  const desks = department?.headcount;
  useEffect(() => {
    if (desks) setHeadcount(desks);
  }, [desks]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body = { name, genre, description, headcount, webAccess, codeAccess, model: model || null, effort: effort || null };
    if (department) await api("PATCH", `/api/departments/${department.id}`, body);
    else await api("POST", "/api/departments", body);
    showToast(department ? `${name} updated.` : `${name} is open for business.`);
    openModal(null);
  };

  const close = async () => {
    if (!department || !confirm(`Close ${department.name}? Its files stay on the drive.`)) return;
    await api("DELETE", `/api/departments/${department.id}`);
    showToast(`${department.name} closed.`);
    openModal(null);
  };

  const assign = async (e: FormEvent) => {
    e.preventDefault();
    if (!department) return;
    await api("POST", `/api/departments/${department.id}/tasks`, { title: taskTitle, brief: taskBrief, employee: taskEmployee });
    const who = staff.find((e) => e.id === taskEmployee)?.name ?? department.name;
    showToast(`Task handed to ${who}.`);
    clearTaskTitle();
    clearTaskBrief();
  };

  return (
    <Modal title={department ? department.name : "Open a department"}>
      <form className="form" onSubmit={save}>
        <div className="form__row">
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Marketing" maxLength={40} required />
          </label>
          <label className="form__narrow">
            Desks
            <input
              type="number"
              min={Math.max(1, staff.length)}
              max={MAX_HEADCOUNT}
              value={headcount}
              onChange={(e) => setHeadcount(Math.max(1, Math.min(MAX_HEADCOUNT, Number(e.target.value) || 1)))}
            />
          </label>
        </div>
        <label>
          Kind of work
          <input
            value={genre}
            onChange={(e) => setGenre(e.target.value)}
            placeholder="Copywriting, social posts and campaigns"
            maxLength={120}
          />
        </label>
        <label>
          Standing instructions
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            maxLength={2000}
            placeholder="Friendly, plain-English tone. Our audience is busy small-business owners. Keep posts under 200 words."
          />
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={webAccess} onChange={(e) => setWebAccess(e.target.checked)} />
          Workers may search and read the web
        </label>
        <label className="checkbox toggle">
          <input type="checkbox" checked={codeAccess} onChange={(e) => setCodeAccess(e.target.checked)} />
          <span>
            <strong>Workers may change Siverse's own code</strong>
            <small>
              For a team that improves this app (Claude Code engine). They still can't change <code>data/</code>,{" "}
              <code>.env</code> or the code that enforces your approvals, but any server code runs inside Siverse, so
              only turn this on for work you trust. Their server edits restart the office, which ends any task running
              at the time.
            </small>
          </span>
        </label>
        <div className="form__row">
          <label>
            Model
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">Office default ({modelLabel(settings?.workerModel)})</option>
              {model && !MODEL_OPTIONS.some((m) => m.id === model) && <option value={model}>{model}</option>}
              {MODEL_OPTIONS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Effort
            <select value={effort} onChange={(e) => setEffort(e.target.value as Effort | "")}>
              <option value="">Default ({settings?.engine === "claude-code" ? "Claude Code's own" : "medium"})</option>
              {EFFORT_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {EFFORT_LABELS[level]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="hint tiny">
          For this department's workers, from their next task. Higher effort thinks longer and does more thorough work,
          but takes longer and uses more of your {settings?.engine === "claude-code" ? "plan" : "API budget"}.
        </p>
        <div className="form__actions">
          {department && (
            <button type="button" className="btn btn--danger btn--ghost" onClick={close}>
              Close department
            </button>
          )}
          <span className="spacer" />
          <button className="btn btn--primary" type="submit">
            {department ? "Save" : "Open department"}
          </button>
        </div>
      </form>

      {department && <TeamSection department={department} staff={staff} tasks={tasks} />}

      {department && (
        <form className="form form--section" onSubmit={assign}>
          <h3>Hand them a task directly</h3>
          {staff.length > 0 && <EmployeeSelect staff={staff} value={taskEmployee} onChange={setTaskEmployee} label="For" />}
          <input value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} placeholder="Task title" maxLength={120} required />
          <textarea
            value={taskBrief}
            onChange={(e) => setTaskBrief(e.target.value)}
            rows={3}
            placeholder="What should they make? Who is it for? How long?"
            required
          />
          <div className="form__actions">
            <button className="btn btn--primary" type="submit">
              Assign task
            </button>
          </div>
        </form>
      )}

      {department && <SchedulesSection department={department} staff={staff} schedules={schedules} />}
      {department && <CommandsSection department={department} commands={commands} />}
    </Modal>
  );
}

const ASK_FIRST: Record<AskFirst, string> = {
  always: "Every time",
  "with-args": "Only when it has arguments",
  never: "Never",
};
// Shown next to the riskier ask-first choices, in the add form and on each approved command.
const ASK_FIRST_WARNING: Partial<Record<AskFirst, string>> = {
  "with-args":
    "⚠️ Only safe if running the script with no arguments is a real dry run that changes nothing. Workers run it bare without asking.",
  never: "⚠️ Workers run this command unattended, with any arguments, and you won't be asked.",
};
const SCRIPT_EXTENSIONS = /\.(py|js|mjs|cjs|sh|ps1|rb|php|pl)$/i;

/** A sensible program for a script, which the boss can change. */
function programFor(script: string) {
  const ext = script.split(".").pop()?.toLowerCase();
  if (ext === "py") return navigator.userAgent.includes("Windows") ? "py" : "python3";
  if (ext === "js" || ext === "mjs" || ext === "cjs") return "node";
  if (ext === "sh") return "bash";
  if (ext === "ps1") return "powershell";
  return ext ?? "";
}

/** Scripts the boss allows this department's workers to run, through Siverse, never a shell. */
function CommandsSection({ department, commands }: { department: Department; commands: CommandView[] }) {
  const showToast = useStore((s) => s.showToast);
  const [adding, setAdding] = useState(false);
  const [scripts, setScripts] = useState<string[] | null>(null);
  const [name, setName] = useState("");
  const [script, setScript] = useState("");
  const [program, setProgram] = useState("");
  const [description, setDescription] = useState("");
  const [askFirst, setAskFirst] = useState<AskFirst>("always");
  const [secrets, setSecrets] = useState("");

  useEffect(() => {
    if (!adding) return;
    api<{ files: string[] }>("GET", `/api/files?folder=${encodeURIComponent(department.id)}`).then(
      (r) => setScripts(r.files.filter((f) => SCRIPT_EXTENSIONS.test(f)).map((f) => f.slice(department.id.length + 1))),
      () => setScripts([]),
    );
  }, [adding, department.id]);

  const pick = (file: string) => {
    setScript(file);
    setProgram(programFor(file));
    if (!name) setName(file.split("/").pop()?.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9_-]/g, "_") ?? "");
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    await api("POST", `/api/departments/${department.id}/commands`, {
      name,
      script,
      program,
      description,
      askFirst,
      secrets: secrets.split(/[\s,]+/).filter(Boolean),
    });
    showToast(`${department.name} can now run ${name}.`);
    setAdding(false);
    setName("");
    setScript("");
    setDescription("");
    setSecrets("");
  };

  return (
    <section className="form form--section">
      <h3>🔐 Approved commands</h3>
      <p className="muted tiny">
        Workers have no shell. They can only run scripts you approve here, and Siverse runs them: the approved copy
        (workers can't edit it), without a shell, with only the environment variables you name. Workers never see those
        values.
      </p>
      {commands.length > 0 && (
        <ul className="schedule-list">
          {commands.map((c) => (
            <CommandRow key={c.id} command={c} />
          ))}
        </ul>
      )}
      {adding ? (
        <form className="form" onSubmit={add}>
          <label>
            Script from {department.name}'s folder
            {scripts === null ? (
              <span className="muted tiny">Loading…</span>
            ) : scripts.length === 0 ? (
              <span className="muted tiny">No scripts in this folder yet (.py, .js, .sh, .ps1 …).</span>
            ) : (
              <select value={script} onChange={(e) => pick(e.target.value)} required>
                <option value="" disabled>
                  Pick a script
                </option>
                {scripts.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            )}
          </label>
          <div className="form__row">
            <label>
              Name for workers
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="send_email" maxLength={40} required />
            </label>
            <label className="form__narrow">
              Program
              <input value={program} onChange={(e) => setProgram(e.target.value)} placeholder="py" maxLength={200} required />
            </label>
          </div>
          <label>
            What it does, and how to use it
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              maxLength={1000}
              placeholder="Sends email.txt to send-list.csv. No arguments: dry run. --test: one copy to me. --send --limit 20: the next 20."
            />
          </label>
          <div className="form__row">
            <label>
              Ask me first
              <select value={askFirst} onChange={(e) => setAskFirst(e.target.value as AskFirst)}>
                {(Object.keys(ASK_FIRST) as AskFirst[]).map((k) => (
                  <option key={k} value={k}>
                    {ASK_FIRST[k]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Environment variables it gets
              <input value={secrets} onChange={(e) => setSecrets(e.target.value)} placeholder="SMTP_USER, SMTP_PASSWORD" />
            </label>
          </div>
          {ASK_FIRST_WARNING[askFirst] && <p className="hint tiny command__warn">{ASK_FIRST_WARNING[askFirst]}</p>}
          <p className="hint tiny">
            Names only: never type a password here. Put the values in Siverse's <code>.env</code> file (or your
            environment). Siverse reads them when the command runs, and no Claude run can read <code>.env</code>.
          </p>
          <div className="form__actions">
            <button type="button" className="btn btn--ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button className="btn btn--primary" type="submit" disabled={!script}>
              Approve this script
            </button>
          </div>
        </form>
      ) : (
        <div className="form__actions">
          <span className="spacer" />
          <button type="button" className="btn btn--primary btn--sm" onClick={() => setAdding(true)}>
            ＋ Approve a script
          </button>
        </div>
      )}
    </section>
  );
}

function CommandRow({ command }: { command: CommandView }) {
  const showToast = useStore((s) => s.showToast);
  const openModal = useStore((s) => s.openModal);
  const setAsk = (askFirst: AskFirst) => api("PATCH", `/api/commands/${command.id}`, { askFirst });
  const reapprove = async () => {
    if (!confirm(`Approve the current version of ${command.script}? Read it first: workers may have changed it.`)) return;
    await api("POST", `/api/commands/${command.id}/reapprove`);
    showToast(`Approved the new version of ${command.name}.`);
  };
  const remove = async () => {
    if (!confirm(`Stop ${command.name} from running? The script stays on the drive.`)) return;
    await api("DELETE", `/api/commands/${command.id}`);
  };
  return (
    <li className="schedule employee">
      <div className="schedule__text">
        <strong>{command.name}</strong>
        <small>
          <code>
            {command.program} {command.script.split("/").pop()}
          </code>{" "}
          in {command.script.split("/").slice(0, -1).join("/")}/ · approved {new Date(command.approvedAt).toLocaleDateString()}
        </small>
        {command.description && <small>{command.description}</small>}
        <small>
          Ask me first:{" "}
          <select className="inline-select" value={command.askFirst} onChange={(e) => setAsk(e.target.value as AskFirst)}>
            {(Object.keys(ASK_FIRST) as AskFirst[]).map((k) => (
              <option key={k} value={k}>
                {ASK_FIRST[k]}
              </option>
            ))}
          </select>
        </small>
        {ASK_FIRST_WARNING[command.askFirst] && <small className="command__warn">{ASK_FIRST_WARNING[command.askFirst]}</small>}
        {command.secrets.length > 0 && (
          <small>
            Gets{" "}
            {command.secrets.map((s, i) => (
              <span key={s}>
                {i ? ", " : ""}
                <code>{s}</code> {command.missingSecrets.includes(s) ? "⚠️ not set" : "✓"}
              </span>
            ))}
          </small>
        )}
        {command.scriptChanged && (
          <small className="command__warn">
            ⚠️ The script on the drive has changed since you approved it. The approved version still runs.{" "}
            <button type="button" className="link" onClick={() => openModal({ type: "file", path: command.script })}>
              Read it
            </button>
            , then{" "}
            <button type="button" className="link" onClick={reapprove}>
              approve this version
            </button>
            .
          </small>
        )}
      </div>
      <div className="schedule__actions">
        <button type="button" className="btn btn--ghost btn--danger btn--sm" onClick={remove} aria-label={`Remove ${command.name}`}>
          ✕
        </button>
      </div>
    </li>
  );
}

function EmployeeSelect({
  staff,
  value,
  onChange,
  label,
}: {
  staff: Employee[];
  value: string;
  onChange: (id: string) => void;
  label: string;
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Whoever is free</option>
        {staff.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name} · {e.focus}
          </option>
        ))}
      </select>
    </label>
  );
}

function TeamSection({ department, staff, tasks }: { department: Department; staff: Employee[]; tasks: Task[] }) {
  const showToast = useStore((s) => s.showToast);
  const [hiring, setHiring] = useState(false);
  const [name, setName] = useState("");
  const [focus, setFocus] = useState("");
  const full = staff.length >= MAX_HEADCOUNT;

  const hire = async (e: FormEvent) => {
    e.preventDefault();
    const hired = await api<Employee>("POST", `/api/departments/${department.id}/employees`, { name, focus });
    showToast(`${hired.name} joined ${department.name} at desk ${hired.deskIndex + 1}.`);
    setName("");
    setFocus("");
    setHiring(false);
  };

  const temps = department.headcount - staff.length;
  return (
    <section className="form form--section">
      <h3>👥 Team</h3>
      <p className="muted tiny">
        Permanent employees keep their own desk, focus on one area, and keep their own notes, so they get better at it
        over time. {staff.length ? `${temps} of ${department.headcount} desk(s) are for temps, who come in for one task.` : "Right now every desk is for temps, who come in for one task."}
      </p>
      {staff.length > 0 && (
        <ul className="schedule-list">
          {staff.map((employee) => (
            <EmployeeRow key={employee.id} employee={employee} tasks={tasks} />
          ))}
        </ul>
      )}
      {hiring ? (
        <form className="form" onSubmit={hire}>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Leave empty to pick one" maxLength={30} />
          </label>
          <label>
            Their area
            <textarea
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              rows={2}
              maxLength={400}
              placeholder="e.g. Competitor pricing and promotions in Europe"
              required
            />
          </label>
          <div className="form__actions">
            <button type="button" className="btn btn--ghost" onClick={() => setHiring(false)}>
              Cancel
            </button>
            <button className="btn btn--primary" type="submit">
              Hire
            </button>
          </div>
        </form>
      ) : (
        <div className="form__actions">
          <span className="spacer" />
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => setHiring(true)}
            disabled={full}
            title={full ? `Every one of the ${MAX_HEADCOUNT} desks has a permanent employee.` : undefined}
          >
            ＋ Hire
          </button>
        </div>
      )}
    </section>
  );
}

function EmployeeRow({ employee, tasks }: { employee: Employee; tasks: Task[] }) {
  const showToast = useStore((s) => s.showToast);
  const selectTask = useStore((s) => s.selectTask);
  const openModal = useStore((s) => s.openModal);
  const [mode, setMode] = useState<"view" | "edit" | "fire">("view");
  const [name, setName] = useState(employee.name);
  const [focus, setFocus] = useState(employee.focus);
  const current = tasks.find((t) => t.employeeId === employee.id && t.status === "working");
  const waiting = tasks.filter((t) => t.employeeId === employee.id && t.status === "queued").length;
  const done = tasks.filter((t) => t.employeeId === employee.id && t.status === "done").length;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    await api("PATCH", `/api/employees/${employee.id}`, { name, focus });
    showToast(`${name} updated.`);
    setMode("view");
  };

  const fire = async (deleteNotes: boolean) => {
    await api("DELETE", `/api/employees/${employee.id}?deleteNotes=${deleteNotes}`);
    showToast(deleteNotes ? `${employee.name} has left, and their notes are deleted.` : `${employee.name} has left. Their notes are kept.`);
  };

  if (mode === "edit") {
    return (
      <li className="schedule">
        <form className="form employee__edit" onSubmit={save}>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={30} required aria-label="Name" />
          <textarea value={focus} onChange={(e) => setFocus(e.target.value)} rows={2} maxLength={400} required aria-label="Their area" />
          <div className="form__actions">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setMode("view")}>
              Cancel
            </button>
            <button className="btn btn--primary btn--sm" type="submit">
              Save
            </button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className="schedule employee">
      <div className="schedule__text">
        <strong>
          {employee.name} <span className="muted tiny">· desk {employee.deskIndex + 1}</span>
        </strong>
        <small>{employee.focus}</small>
        <small>
          {current ? (
            <button
              type="button"
              className="link"
              onClick={() => {
                selectTask(current.id);
                openModal(null);
              }}
            >
              Working on "{current.title}"
            </button>
          ) : (
            "Free"
          )}
          {waiting ? ` · ${waiting} waiting` : ""}
          {done ? ` · ${done} done recently` : ""}
        </small>
        {mode === "fire" && (
          <div className="employee__fire">
            <span>
              Fire {employee.name}? Their desk stays for temps, and work waiting for them goes to whoever is free. Their
              notes are in <code>data/memory/employees/{employee.id}</code>.
            </span>
            <div className="form__actions">
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setMode("view")}>
                Cancel
              </button>
              <button type="button" className="btn btn--danger btn--ghost btn--sm" onClick={() => fire(false)}>
                Fire, keep notes
              </button>
              <button type="button" className="btn btn--danger btn--sm" onClick={() => fire(true)}>
                Fire and delete notes
              </button>
            </div>
          </div>
        )}
      </div>
      {mode === "view" && (
        <div className="schedule__actions">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              setName(employee.name);
              setFocus(employee.focus);
              setMode("edit");
            }}
          >
            Edit
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--danger btn--sm"
            onClick={() => setMode("fire")}
            disabled={Boolean(current)}
            title={current ? "Wait for them to finish, or send them home first." : undefined}
          >
            Fire
          </button>
        </div>
      )}
    </li>
  );
}

function SchedulesSection({ department, staff, schedules }: { department: Department; staff: Employee[]; schedules: Schedule[] }) {
  const showToast = useStore((s) => s.showToast);
  const [adding, setAdding] = useState(false);
  const hasTidyUp = schedules.some((s) => s.title.startsWith("Tidy up"));

  const add = async (values: ScheduleValues) => {
    await api("POST", `/api/departments/${department.id}/schedules`, values);
    const who = staff.find((e) => e.id === values.employee)?.name ?? department.name;
    showToast(`${who} will do "${values.title}" ${describeCadence(values.cadence).toLowerCase()}.`);
    setAdding(false);
  };

  const addTidyUp = async () => {
    await api("POST", `/api/departments/${department.id}/schedules/notes-tidy-up`);
    showToast(`${department.name} will tidy up its notes every Sunday evening.`);
  };

  return (
    <section className="form form--section">
      <h3>⏰ Recurring tasks</h3>
      {schedules.length === 0 ? (
        <p className="muted tiny">
          None yet. A recurring task runs on a timetable, and each run builds on the last one's work and the
          department's notes.
        </p>
      ) : (
        <PipelineStrip department={department} staff={staff} />
      )}
      {schedules.length > 0 && (
        <ul className="schedule-list">
          {schedules.map((s) => (
            <ScheduleRow key={s.id} schedule={s} staff={staff} />
          ))}
        </ul>
      )}

      {adding ? (
        <ScheduleForm staff={staff} submitLabel="Add recurring task" onSubmit={add} onCancel={() => setAdding(false)} />
      ) : (
        <div className="form__actions">
          {!hasTidyUp && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={addTidyUp} title="Every Sunday at 20:00">
              🧹 Weekly notes tidy-up
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn btn--primary btn--sm" onClick={() => setAdding(true)}>
            ＋ Recurring task
          </button>
        </div>
      )}
    </section>
  );
}

interface ScheduleValues {
  title: string;
  brief: string;
  cadence: ScheduleCadence;
  employee: string; // employee id, "" = whoever is free
}

/** The fields of a recurring task, for adding one or editing it. */
function ScheduleForm({
  staff,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  staff: Employee[];
  initial?: Schedule;
  submitLabel: string;
  onSubmit: (values: ScheduleValues) => Promise<void>;
  onCancel: () => void;
}) {
  const start = initial?.cadence;
  const [title, setTitle] = useState(initial?.title ?? "");
  const [brief, setBrief] = useState(initial?.brief ?? "");
  const [employee, setEmployee] = useState(initial?.employeeId ?? "");
  const [kind, setKind] = useState<ScheduleCadence["kind"]>(start?.kind ?? "weekly");
  const [time, setTime] = useState(start?.kind === "daily" || start?.kind === "weekly" ? start.time : "09:00");
  const [day, setDay] = useState(start?.kind === "weekly" ? start.day : 1);
  const [hours, setHours] = useState(start?.kind === "interval" ? start.hours : 24);
  const [leader, setLeader] = useState(start?.kind === "after" ? start.scheduleId : "");
  const [saving, setSaving] = useState(false);
  // Any schedule in the office can lead, not just this department's; never the one being edited.
  const allSchedules = useStore((s) => s.snapshot?.schedules ?? []);
  const departments = useStore((s) => s.snapshot?.departments ?? []);
  const leaders = allSchedules.filter((s) => s.id !== initial?.id);

  const cadence = (): ScheduleCadence =>
    kind === "daily"
      ? { kind, time }
      : kind === "weekly"
        ? { kind, day, time }
        : kind === "after"
          ? { kind, scheduleId: leader }
          : { kind, hours };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSubmit({ title, brief, cadence: cadence(), employee });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="form" onSubmit={submit}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Weekly lead list" maxLength={120} required aria-label="Title" />
      <textarea
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        rows={initial ? 5 : 3}
        maxLength={8000}
        placeholder="What should they do each time? e.g. Find new competitors that launched this week and add them to competitors.csv"
        required
        aria-label="What to do each time"
      />
      <p className="muted tiny">
        {"{date}"} becomes the run's date (YYYY-MM-DD) and {"{weekday}"} its day, e.g. reports/{"{date}"}/.
      </p>
      {staff.length > 0 && <EmployeeSelect staff={staff} value={employee} onChange={setEmployee} label="Done by" />}
      <div className="form__row">
        <label>
          Runs
          <select value={kind} onChange={(e) => setKind(e.target.value as ScheduleCadence["kind"])}>
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
            <option value="interval">Every few hours</option>
            {(leaders.length > 0 || kind === "after") && <option value="after">After another recurring task</option>}
          </select>
        </label>
        {kind === "weekly" && (
          <label>
            On
            <select value={day} onChange={(e) => setDay(Number(e.target.value))}>
              {WEEKDAYS.map((name, i) => (
                <option key={name} value={i}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
        {(kind === "daily" || kind === "weekly") && (
          <label className="form__narrow">
            At
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
          </label>
        )}
        {kind === "after" && (
          <label>
            After
            <select value={leader} onChange={(e) => setLeader(e.target.value)} required>
              <option value="">Pick one…</option>
              {leaders.map((s) => (
                <option key={s.id} value={s.id}>
                  {departments.find((d) => d.id === s.departmentId)?.name ?? "Closed department"} · {s.title}
                </option>
              ))}
            </select>
          </label>
        )}
        {kind === "interval" && (
          <label className="form__narrow">
            Hours
            <input
              type="number"
              min={1}
              max={24 * 28}
              value={hours}
              onChange={(e) => setHours(Math.max(1, Number(e.target.value) || 1))}
            />
          </label>
        )}
      </div>
      <div className="form__actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn--primary" type="submit" disabled={saving}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

const LAST_OUTCOME = {
  done: "✅ done",
  failed: "⚠️ failed",
  working: "⏳ running",
  queued: "· waiting",
  cancelled: "✕ cancelled",
} as const;

/** One row per chain that runs through this department: each step and how it went this round. */
function PipelineStrip({ department, staff }: { department: Department; staff: Employee[] }) {
  const schedules = useStore((s) => s.snapshot?.schedules);
  const tasks = useStore((s) => s.snapshot?.tasks);
  const employees = useStore((s) => s.snapshot?.employees);
  const selectTask = useStore((s) => s.selectTask);
  const openModal = useStore((s) => s.openModal);
  if (!schedules || !tasks) return null;
  const chains = schedules
    .filter((s) => s.cadence.kind !== "after")
    .map((root) => chainFrom(root, schedules))
    .filter((steps) => steps.length > 1 && steps.some((step) => step.schedule.departmentId === department.id));
  if (!chains.length) return null;
  const nameOf = (id?: string) => (employees ?? staff).find((e) => e.id === id)?.name;

  return (
    <div className="pipelines">
      {chains.map((steps) => {
        const round = steps[0].schedule.lastRunAt ?? 0; // this round started when the leader last ran
        let broken = false;
        return (
          <ol key={steps[0].schedule.id} className="pipeline tiny" aria-label="Chained recurring tasks">
            {steps.map(({ schedule, more }, i) => {
              const last = schedule.lastTaskId ? tasks.find((t) => t.id === schedule.lastTaskId) : undefined;
              const thisRound = round > 0 && (schedule.lastRunAt ?? 0) >= round;
              const status = thisRound
                ? last
                  ? LAST_OUTCOME[last.status]
                  : "✅ ran"
                : broken
                  ? "⏭️ skipped"
                  : "· not yet";
              if (thisRound && (last?.status === "failed" || last?.status === "cancelled")) broken = true;
              const who = nameOf(schedule.employeeId);
              const label = `${schedule.title}${who ? ` (${who})` : ""}`;
              return (
                <li key={schedule.id} className="pipeline__step">
                  {i > 0 && <span className="pipeline__arrow" aria-hidden="true">→</span>}
                  {last ? (
                    <button
                      type="button"
                      className="link"
                      onClick={() => {
                        selectTask(last.id);
                        openModal(null);
                      }}
                      title="Open its last run"
                    >
                      {label}
                    </button>
                  ) : (
                    <span>{label}</span>
                  )}{" "}
                  <span className="muted">{status}</span>
                  {more > 0 && <span className="muted"> +{more}</span>}
                </li>
              );
            })}
          </ol>
        );
      })}
    </div>
  );
}

function ScheduleRow({ schedule, staff }: { schedule: Schedule; staff: Employee[] }) {
  const showToast = useStore((s) => s.showToast);
  const selectTask = useStore((s) => s.selectTask);
  const openModal = useStore((s) => s.openModal);
  // Missing once it drops out of the snapshot (only the latest finished tasks are sent).
  const lastTask = useStore((s) =>
    schedule.lastTaskId ? s.snapshot?.tasks.find((t) => t.id === schedule.lastTaskId) : undefined,
  );
  const leaderId = schedule.cadence.kind === "after" ? schedule.cadence.scheduleId : undefined;
  const leader = useStore((s) => (leaderId ? s.snapshot?.schedules.find((l) => l.id === leaderId) : undefined));
  // "Start it now, then Leo, then Sofia" when others run after this one. A string, so the selector stays cheap.
  const runTitle = useStore((s) => {
    const all = s.snapshot?.schedules ?? [];
    const rest = chainFrom(schedule, all).slice(1);
    if (!rest.length) return "Start it now";
    const names = rest.map(({ schedule: f }) => s.snapshot?.employees.find((e) => e.id === f.employeeId)?.name ?? f.title);
    return `Start it now, then ${names.join(", then ")}`;
  });
  const [editing, setEditing] = useState(false);
  const employee = staff.find((e) => e.id === schedule.employeeId);
  const openLastTask = () => {
    if (!lastTask) return;
    selectTask(lastTask.id);
    openModal(null);
  };
  const toggle = () => api("PATCH", `/api/schedules/${schedule.id}`, { enabled: !schedule.enabled });
  const runNow = async () => {
    await api("POST", `/api/schedules/${schedule.id}/run`);
    showToast(`Started "${schedule.title}".`);
  };
  const remove = async () => {
    if (!confirm(`Remove the recurring task "${schedule.title}"?`)) return;
    await api("DELETE", `/api/schedules/${schedule.id}`);
  };
  const save = async (values: ScheduleValues) => {
    // Only send a new timetable when it changed: a new timetable starts counting from now.
    const sameTimetable = JSON.stringify(values.cadence) === JSON.stringify(schedule.cadence);
    await api("PATCH", `/api/schedules/${schedule.id}`, {
      title: values.title,
      brief: values.brief,
      employee: values.employee || null,
      ...(sameTimetable ? {} : { cadence: values.cadence }),
    });
    showToast(`Saved "${values.title}".`);
    setEditing(false);
  };

  if (editing) {
    return (
      <li className="schedule schedule--editing">
        <ScheduleForm staff={staff} initial={schedule} submitLabel="Save" onSubmit={save} onCancel={() => setEditing(false)} />
      </li>
    );
  }

  return (
    <li className={`schedule${schedule.enabled ? "" : " schedule--paused"}`}>
      <div className="schedule__text">
        <strong>{schedule.title}</strong>
        <small>
          {employee ? `${employee.name} · ` : ""}
          {leader ? `After "${leader.title}"` : describeCadence(schedule.cadence)} ·{" "}
          {!schedule.enabled ? "paused" : leaderId ? "starts when it finishes" : `next ${formatWhen(schedule.nextRunAt)}`}
          {schedule.lastRunAt ? ` · last ${formatWhen(schedule.lastRunAt)}` : ""}
          {lastTask && (
            <>
              {" "}
              <button type="button" className="link" onClick={openLastTask} title="Open the last run">
                {LAST_OUTCOME[lastTask.status]}
              </button>
            </>
          )}
        </small>
      </div>
      <div className="schedule__actions">
        <button type="button" className="btn btn--ghost btn--sm" onClick={runNow} title={runTitle}>
          ▶
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(true)}>
          Edit
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={toggle}>
          {schedule.enabled ? "Pause" : "Resume"}
        </button>
        <button type="button" className="btn btn--ghost btn--danger btn--sm" onClick={remove} aria-label="Remove">
          ✕
        </button>
      </div>
    </li>
  );
}

function formatWhen(at: number) {
  return new Date(at).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

const DRIVE_LIST_CAP = 300; // must match MAX_LIST_ENTRIES in server/drive.ts:10

function DriveModal() {
  const openModal = useStore((s) => s.openModal);
  const [files, setFiles] = useState<string[] | null>(null);
  useEffect(() => {
    api<{ files: string[] }>("GET", "/api/files").then((r) => setFiles(r.files), () => setFiles([]));
  }, []);

  const byFolder = new Map<string, string[]>();
  for (const file of files ?? []) {
    const folder = file.split("/")[0];
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), file]);
  }

  return (
    <Modal title="Company drive" wide>
      {files && files.length >= DRIVE_LIST_CAP && (
        <p className="hint">
          Showing the first {DRIVE_LIST_CAP} files. Folders later in the alphabet may be missing. Open a department's
          window to see all of its files.
        </p>
      )}
      {files === null ? (
        <p className="muted">Loading…</p>
      ) : files.length === 0 ? (
        <p className="muted">Nothing here yet. Files your workers make show up here, one folder per department.</p>
      ) : (
        [...byFolder].map(([folder, list]) => (
          <section key={folder} className="drive-folder">
            <h4>📁 {folder}</h4>
            <ul className="file-list">
              {list.map((path) => (
                <li key={path}>
                  <button className="link" onClick={() => openModal({ type: "file", path })}>
                    📄 {path.slice(folder.length + 1)}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </Modal>
  );
}

function FileModal({ path }: { path: string }) {
  const [content, setContent] = useState<string | null>(null);
  useEffect(() => {
    api<{ content: string }>("GET", `/api/file?path=${encodeURIComponent(path)}`).then(
      (r) => setContent(r.content),
      () => setContent(""),
    );
  }, [path]);
  const isMarkdown = /\.(md|markdown)$/i.test(path);
  return (
    <Modal title={path} wide>
      {content === null ? (
        <p className="muted">Loading…</p>
      ) : isMarkdown ? (
        <div className="prose">
          <DriveMarkdown base={path.slice(0, path.lastIndexOf("/") + 1)}>{content}</DriveMarkdown>
        </div>
      ) : (
        <pre className="code">{content}</pre>
      )}
    </Modal>
  );
}

function ClaudeCodeProjectModal({ department, snapshot }: { department: Department; snapshot: Snapshot }) {
  const selectTask = useStore((s) => s.selectTask);
  const openModal = useStore((s) => s.openModal);
  const workers = snapshot.tasks.filter((t) => t.departmentId === department.id && t.status === "working");
  return (
    <Modal title={`⚡ ${department.name}`}>
      <p className="hint">
        A Claude Code project at <code>{department.projectPath}</code>. Siverse shows what your Claude Code sessions
        here are doing. To give them work, type in Claude Code.
      </p>
      <h4>At work now</h4>
      {workers.length === 0 ? (
        <p className="muted">Nobody right now.</p>
      ) : (
        <ul className="file-list">
          {workers.map((t) => (
            <li key={t.id}>
              <button
                className="link"
                onClick={() => {
                  selectTask(t.id);
                  openModal(null);
                }}
              >
                {t.kind === "subagent" ? "👥" : "🧑‍💻"} {t.workerName}: {t.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
