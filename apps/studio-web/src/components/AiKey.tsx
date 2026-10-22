import { useCallback, useEffect, useState } from "react";
import { formatNear, type LlmKeySummary, type LlmModel, type LlmProvider, type LlmProviderInfo, type PlatformKeyInfo } from "@osl/schema";
import { deleteLlmKey, getMyKey, getPlatformKey, listLlmModels, llmProviders, saveLlmKey, testLlmKey, type KeyScope } from "../lib/api";

/**
 * "AI key" settings: pick a provider (fixed allowlist), paste a key, pick a model from the provider's /models
 * (fetched by the API with that key), save. The API validates and stores it encrypted; it never sends the key
 * back, only provider/model/last 4/dates/validity. scope="platform" is the Admin tab's platform default key.
 */
export default function AiKey({
  scope,
  getToken,
  onAuthError,
  onChange,
  aiCost,
}: {
  scope: KeyScope;
  getToken: () => Promise<string | null>;
  onAuthError?: (e: Error) => void;
  onChange?: (k: LlmKeySummary | null) => void;
  aiCost?: string | null;
}) {
  const [providers, setProviders] = useState<LlmProviderInfo[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [key, setKey] = useState<LlmKeySummary | null | undefined>(undefined);
  const [platform, setPlatform] = useState<PlatformKeyInfo | null>(null);
  const [open, setOpen] = useState(scope === "platform");
  const [mode, setMode] = useState<"view" | "new" | "model">("view");
  const [provider, setProvider] = useState<LlmProvider>("nearai");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<LlmModel[] | null>(null);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const apply = useCallback(
    (k: LlmKeySummary | null, p?: Partial<PlatformKeyInfo>) => {
      setKey(k);
      if (p && "active" in p && p.env) setPlatform({ stored: k, env: p.env, active: p.active! });
      onChange?.(k);
    },
    [onChange],
  );

  const act = async (name: string, fn: (token: string) => Promise<void>) => {
    setBusy(name);
    setMsg(null);
    try {
      const token = await getToken();
      if (!token) return;
      await fn(token);
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
      onAuthError?.(e as Error);
    } finally {
      setBusy(null);
    }
  };

  const load = useCallback(async () => {
    llmProviders()
      .then((r) => (setProviders(r.providers), setEnabled(r.enabled)))
      .catch(() => {});
    const token = await getToken().catch(() => null);
    if (!token) return;
    try {
      if (scope === "platform") {
        const p = await getPlatformKey(token);
        setPlatform(p);
        setEnabled(p.enabled);
        apply(p.stored);
      } else {
        const r = await getMyKey(token);
        setEnabled(r.enabled);
        apply(r.key);
      }
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
      onAuthError?.(e as Error);
    }
  }, [scope, getToken, apply, onAuthError]);
  useEffect(() => void load(), [load]);

  const pinfo = providers.find((p) => p.id === provider);
  const label = (id: string) => providers.find((p) => p.id === id)?.label ?? id;
  const resetForm = () => {
    setApiKey("");
    setModels(null);
    setModel("");
  };
  const startNew = () => {
    resetForm();
    if (key) setProvider(key.provider);
    setMode("new");
    setOpen(true);
  };

  const fetchModels = (useStored: boolean) =>
    act("models", async (token) => {
      const r = await listLlmModels(scope, provider, useStored ? undefined : apiKey, token);
      setModels(r.models);
      setModel((m) => (m && r.models.some((x) => x.id === m) ? m : (useStored && key?.provider === provider ? key.model : (r.defaultModel ?? r.models[0]?.id ?? ""))));
      if (!r.models.length) setMsg({ kind: "err", text: "The provider returned no models." });
    });

  const save = (keepKey: boolean) =>
    act("save", async (token) => {
      const r = await saveLlmKey(scope, { provider, ...(keepKey ? {} : { apiKey }), ...(model ? { model } : {}) }, token);
      resetForm();
      setMode("view");
      apply(r.key, r);
      setMsg({ kind: "ok", text: `Saved and validated: ${r.key.providerLabel} · ${r.key.model} · …${r.key.last4}` });
    });

  const test = () =>
    act("test", async (token) => {
      const r = await testLlmKey(scope, token);
      if (r.key !== undefined || scope === "user") apply(r.key ?? null, r);
      else if (r.env) setPlatform({ stored: null, env: r.env, active: r.active! });
      setMsg(r.ok ? { kind: "ok", text: `Key works${r.tested === "env" ? " (env NEARAI_API_KEY)" : ""}.` } : { kind: "err", text: r.error ?? "Key check failed." });
    });

  const remove = () => {
    if (!confirm(scope === "platform" ? "Delete the stored platform key? Generation falls back to the NEARAI_API_KEY env secret." : "Delete your AI key? Ideas then use the platform key and cost credits again.")) return;
    act("delete", async (token) => {
      const r = await deleteLlmKey(scope, token);
      apply(null, r);
      setMode("view");
      setMsg({ kind: "ok", text: "Key deleted." });
    });
  };

  const disabled = busy !== null;
  const keyOk = apiKey.replace(/\s+/g, "").length >= 8 && apiKey.replace(/\s+/g, "").length <= 512;
  const cost = aiCost ? `${formatNear(BigInt(aiCost), 2)} NEAR` : "the normal fee";
  const status =
    key === undefined ? (
      <span className="muted">Loading…</span>
    ) : key ? (
      <>
        Using {scope === "user" ? "your" : "the stored"} <strong>{key.providerLabel}</strong> key · …{key.last4 ?? "????"} · <code>{key.model}</code>{" "}
        {key.valid ? <span className="badge badge-ok">✓ valid</span> : <span className="badge st-revoked">not working</span>}
        {scope === "user" && key.valid && <span className="muted small"> · no AI fee from your credits</span>}
      </>
    ) : scope === "user" ? (
      <>Using the platform key · {cost} of credits per idea</>
    ) : platform ? (
      <>
        Using the <strong>NEARAI_API_KEY</strong> env secret{platform.env.configured ? <> · {platform.env.provider ? label(platform.env.provider) : platform.env.baseUrl} · …{platform.env.last4} · <code>{platform.env.model}</code></> : " (not set!)"}
      </>
    ) : (
      <span className="muted">Loading…</span>
    );

  const form = (
    <div className="aikey-form">
      <div className="row">
        <span className="muted small">Provider</span>
        <div className="count-pick" role="radiogroup" aria-label="AI provider">
          {providers.map((p) => (
            <button key={p.id} role="radio" aria-checked={provider === p.id} className={provider === p.id ? "on" : ""} disabled={disabled}
              onClick={() => (setProvider(p.id), setModels(null), setModel(""))}>
              {p.label}
            </button>
          ))}
        </div>
        {pinfo && (
          <span className="muted small">
            <code>{pinfo.baseUrl}</code> · get a key at{" "}
            <a href={pinfo.keysUrl} target="_blank" rel="noreferrer">{new URL(pinfo.keysUrl).host}</a>
          </span>
        )}
      </div>
      <div className="row">
        <input
          className="aikey-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          maxLength={2048}
          placeholder={`${pinfo?.label ?? "Provider"} API key`}
          aria-label="API key"
          value={apiKey}
          onChange={(e) => (setApiKey(e.target.value), setModels(null))}
        />
        <button className="ghost" disabled={disabled || !keyOk} onClick={() => fetchModels(false)}>
          {busy === "models" ? "Loading models…" : models ? "↻ Models" : "Load models"}
        </button>
      </div>
      {models && models.length > 0 && (
        <div className="row">
          <label className="small">
            Model{" "}
            <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="model">
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                  {m.price !== undefined ? ` · $${(m.price * 1e6).toFixed(2)}/M out` : ""}
                </option>
              ))}
            </select>
          </label>
          <span className="muted small">Cheap, low-token models are listed first.</span>
        </div>
      )}
      <div className="row">
        <button disabled={disabled || !keyOk || !models || !model} onClick={() => save(false)}>
          {busy === "save" ? "Validating…" : key ? "Replace key" : "Save & validate"}
        </button>
        <button className="ghost" disabled={disabled} onClick={() => (resetForm(), setMode("view"))}>Cancel</button>
      </div>
      <p className="muted small">
        The key is checked with a cheap call to {pinfo?.label ?? "the provider"}, then stored encrypted (AES-256-GCM) on the server. It's never shown again, only its
        last 4 characters. It is only ever sent over HTTPS to <code>{pinfo?.baseUrl ?? "the provider"}</code>.
      </p>
    </div>
  );

  const modelForm = key && (
    <div className="aikey-form">
      <div className="row">
        <button className="ghost" disabled={disabled} onClick={() => (setProvider(key.provider), fetchModels(true))}>
          {busy === "models" ? "Loading models…" : "Load models"}
        </button>
        {models && models.length > 0 && (
          <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="model">
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.id}{m.price !== undefined ? ` · $${(m.price * 1e6).toFixed(2)}/M out` : ""}</option>
            ))}
          </select>
        )}
        <button disabled={disabled || !models || !model || model === key.model} onClick={() => save(true)}>
          {busy === "save" ? "Saving…" : "Save model"}
        </button>
        <button className="ghost" disabled={disabled} onClick={() => (resetForm(), setMode("view"))}>Cancel</button>
      </div>
    </div>
  );

  return (
    <section className={`card aikey run-full${scope === "platform" ? " admin-card" : ""}`}>
      <div className="row between">
        <div>
          <h2>{scope === "platform" ? "Platform AI key" : "AI key"}</h2>
          <p className="small aikey-status">{status}</p>
        </div>
        {scope === "user" && (
          <button className="ghost" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? "Hide" : key ? "Manage key" : "Use your own key"}
          </button>
        )}
      </div>
      {!enabled && <p className="error small">Saving AI keys isn't enabled on this server yet (KEY_ENCRYPTION_KEY missing).</p>}
      {open && enabled && (
        <>
          {scope === "user" ? (
            <p className="muted small">
              Bring your own NEAR AI or Ollama key: ideas then run on your account with that provider and cost <strong>no AI fee</strong> from your credits
              (normally {cost} per idea). Credits are still used for launch deposits.
            </p>
          ) : (
            <p className="muted small">
              Default key for everyone without their own key. Stored encrypted; takes precedence over the <code>NEARAI_API_KEY</code> env secret, which stays the
              fallback (also used if this key stops validating). Admins only.
            </p>
          )}
          {key && mode === "view" && (
            <div className="row aikey-actions">
              <span className="small muted">
                Added {new Date(key.createdAt).toLocaleDateString()} · checked {new Date(key.validatedAt).toLocaleString()}
                {key.lastError ? <> · <span className="error-text">{key.lastError}</span></> : null}
              </span>
              <button className="ghost" disabled={disabled} onClick={test}>{busy === "test" ? "Testing…" : "Test key"}</button>
              <button className="ghost" disabled={disabled} onClick={() => (resetForm(), setMode("model"))}>Change model</button>
              <button className="ghost" disabled={disabled} onClick={startNew}>Replace key</button>
              <button className="ghost danger" disabled={disabled} onClick={remove}>{busy === "delete" ? "Deleting…" : "Delete key"}</button>
            </div>
          )}
          {!key && mode === "view" && key !== undefined && (
            <div className="row">
              <button onClick={startNew}>{scope === "platform" ? "Set platform key" : "Add a key"}</button>
              {scope === "platform" && (
                <button className="ghost" disabled={disabled} onClick={test}>{busy === "test" ? "Testing…" : "Test env key"}</button>
              )}
            </div>
          )}
          {mode === "new" && form}
          {mode === "model" && modelForm}
        </>
      )}
      {msg && <p className={msg.kind === "ok" ? "admin-msg small" : "error small"}>{msg.text}</p>}
    </section>
  );
}
