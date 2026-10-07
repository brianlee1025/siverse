import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import Markdown from "react-markdown";
import { MAX_HEADCOUNT, MODEL_OPTIONS, type Department, type Snapshot } from "../../shared/types";
import { api, useStore } from "../store";

export function Modals({ snapshot }: { snapshot: Snapshot }) {
  const modal = useStore((s) => s.modal);
  if (!modal) return null;
  switch (modal.type) {
    case "settings":
      return <SettingsModal snapshot={snapshot} />;
    case "department": {
      const department = snapshot.departments.find((d) => d.id === modal.departmentId) ?? null;
      if (department?.source === "claude-code") return <ClaudeCodeProjectModal department={department} snapshot={snapshot} />;
      return <DepartmentModal key={modal.departmentId ?? "new"} department={department} />;
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

  const save = async (e: FormEvent) => {
    e.preventDefault();
    await api("PUT", "/api/settings", {
      companyName,
      aiOffice,
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
              Siverse's own manager and workers, who take orders in the chat and do real work. Uses the Claude API,
              which is billed separately from Claude Pro/Max plans. Watching Claude Code doesn't need this.
            </small>
          </span>
        </label>

        {aiOffice && (
          <>
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
              Every running worker is its own stream of API calls. A cheaper worker model lowers the cost of a busy office.
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

function DepartmentModal({ department }: { department: Department | null }) {
  const openModal = useStore((s) => s.openModal);
  const showToast = useStore((s) => s.showToast);
  const [name, setName] = useState(department?.name ?? "");
  const [genre, setGenre] = useState(department?.genre ?? "");
  const [description, setDescription] = useState(department?.description ?? "");
  const [headcount, setHeadcount] = useState(department?.headcount ?? 2);
  const [webAccess, setWebAccess] = useState(department?.webAccess ?? false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskBrief, setTaskBrief] = useState("");

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body = { name, genre, description, headcount, webAccess };
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
    await api("POST", `/api/departments/${department.id}/tasks`, { title: taskTitle, brief: taskBrief });
    showToast(`Task handed to ${department.name}.`);
    setTaskTitle("");
    setTaskBrief("");
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
              min={1}
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
          Workers may search and read the web (uses web search, billed per search)
        </label>
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

      {department && (
        <form className="form form--section" onSubmit={assign}>
          <h3>Hand them a task directly</h3>
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
    </Modal>
  );
}

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
          <Markdown>{content}</Markdown>
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
