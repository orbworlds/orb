"use client";
// "AI" section of the You tab — who builds your worlds.
//
// Designed for everyone (including kids): Orb's AI is the default and needs nothing (it uses the
// person's credits).
// "Use your own AI" is tucked away; there you can connect several providers at once (each keeps
// its key and model), pick models from a friendly list, and tap which one is active. Everything
// saves as you go and lives only in this browser.

import { useEffect, useId, useRef, useState } from "react";
import {
  getAiConfig,
  setAiConfig,
  type AiConfig,
  type ByoProvider,
} from "@/lib/local";
import { DEFAULT_MODELS } from "@/lib/engine/client";
import { track } from "@/lib/analytics";
import { deviceHeaders } from "@/lib/api";
import { Icon, type IconName } from "@/components/ui/Icon";
import {
  fieldClass,
  groupClass,
  SectionHeader,
  Skeleton,
  useHydrated,
} from "./WorldCard";

interface ModelChoice {
  id: string;
  label: string;
  note?: string;
}

interface ProviderInfo {
  id: ByoProvider;
  name: string;
  blurb: string;
  icon: IconName;
  keyPlaceholder: string;
  keyUrl: string;
  privacy: string;
  models: ModelChoice[];
}

const PROVIDERS: ProviderInfo[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    blurb: "Claude, on your Anthropic account",
    icon: "key",
    keyPlaceholder: "sk-ant-…",
    keyUrl: "https://console.anthropic.com/settings/keys",
    privacy: "Your key is saved only in this browser. While a build runs, Orb's server keeps it encrypted so the build can go on without this page — it's deleted when the build ends.",
    models: [
      {
        id: "claude-sonnet-5-5",
        label: "Claude Sonnet 5.5",
        note: "Recommended",
      },
      {
        id: "claude-opus-5-5",
        label: "Claude Opus 5.5",
        note: "Most capable · slower",
      },
      {
        id: "claude-haiku-4-5-20251001",
        label: "Claude Haiku 4.5",
        note: "Fastest",
      },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    blurb: "One key, hundreds of models",
    icon: "globe",
    keyPlaceholder: "sk-or-…",
    keyUrl: "https://openrouter.ai/keys",
    privacy: "Your key is saved only in this browser. While a build runs, Orb's server keeps it encrypted so the build can go on without this page — it's deleted when the build ends.",
    models: [
      {
        id: "anthropic/claude-sonnet-5.5",
        label: "Claude Sonnet 5.5",
        note: "Recommended",
      },
      {
        id: "anthropic/claude-opus-5.5",
        label: "Claude Opus 5.5",
        note: "Most capable",
      },
      { id: "openai/gpt-6.1-sol", label: "GPT-6.1 Sol" },
      {
        id: "google/gemini-3.5-flash",
        label: "Gemini 3.5 Flash",
        note: "Fast",
      },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    blurb: "GPT, on your OpenAI account",
    icon: "bolt",
    keyPlaceholder: "sk-…",
    keyUrl: "https://platform.openai.com/api-keys",
    privacy: "Your key is saved only in this browser. While a build runs, Orb's server keeps it encrypted so the build can go on without this page — it's deleted when the build ends.",
    models: [
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", note: "Recommended" },
      { id: "gpt-6-astra", label: "GPT-6 Astra" },
      { id: "gpt-6-luna", label: "GPT-6 Luna" },
    ],
  },
  {
    id: "cursor",
    name: "Cursor",
    blurb: "A Cursor agent, on your Cursor plan",
    icon: "code",
    keyPlaceholder: "crsr_…",
    keyUrl: "https://cursor.com/dashboard?tab=integrations",
    privacy:
      "Your key is saved only in this browser. A Cursor agent works on the world's files and can keep going for hours — Orb's server keeps your Cursor key encrypted while a build runs and deletes it when it ends. Agents take ~30 s to start.",
    models: [
      {
        id: "claude-sonnet-5-5",
        label: "Claude Sonnet 5.5",
        note: "Recommended",
      },
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", note: "Most capable" },
      { id: "composer-2.5", label: "Composer 2.5", note: "Fast" },
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
    ],
  },
];

const CUSTOM = "__custom__";

/** Anthropic's and OpenAI's reasoning effort, named as they name it (Cursor models list their own options). */
const EFFORT: ModelOption = {
  id: "effort",
  name: "Effort",
  values: ["low", "medium", "high", "xhigh"].map((value) => ({ value, label: value })),
  default: "high",
};

export function ModelSettings() {
  const hydrated = useHydrated();
  return (
    <section aria-labelledby="orb-model-h">
      {hydrated ? (
        <Inner />
      ) : (
        <>
          <SectionHeader
            id="orb-model-h"
            title="AI"
            hint="Who builds your worlds"
          />
          <Skeleton className="h-[120px] rounded-[18px]" />
        </>
      )}
    </section>
  );
}

function Inner() {
  const [cfg, setCfg] = useState<AiConfig>(() => getAiConfig());
  const connectedCount = PROVIDERS.filter((p) => cfg.keys[p.id]).length;
  const [open, setOpen] = useState(cfg.active !== "free" || connectedCount > 0);
  const [expanded, setExpanded] = useState<ByoProvider | null>(
    cfg.active !== "free" ? cfg.active : null,
  );
  // A provider chosen before it has a key becomes active as soon as a key is entered.
  const [wanted, setWanted] = useState<ByoProvider | null>(null);
  const [saved, setSaved] = useState(0);

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(0), 1600);
    return () => clearTimeout(t);
  }, [saved]);

  const update = (next: AiConfig) => {
    setCfg(next);
    setAiConfig(next);
    setSaved((n) => n + 1);
  };

  const useFree = () => {
    setWanted(null);
    update({ ...cfg, active: "free" });
  };

  const pick = (p: ByoProvider) => {
    setExpanded(p);
    if (cfg.keys[p]) {
      setWanted(null);
      if (cfg.active !== p) update({ ...cfg, active: p });
    } else setWanted(p);
  };

  const setKey = (p: ByoProvider, key: string) => {
    const k = key.trim();
    const keys = { ...cfg.keys };
    if (k) keys[p] = k;
    else delete keys[p];
    let active = cfg.active;
    if (!k && active === p) active = "free";
    if (k && wanted === p) active = p;
    if (k && !cfg.keys[p]) track("key_added", { provider: p });
    update({ ...cfg, keys, active });
  };

  const setModel = (p: ByoProvider, model: string) => {
    const models = { ...cfg.models };
    if (model) models[p] = model;
    else delete models[p];
    update({ ...cfg, models });
  };

  const setParams = (p: ByoProvider, model: string, values: Record<string, string>) => {
    const params = { ...(cfg.params ?? {}) };
    params[p] = { ...(params[p] ?? {}), [model]: values };
    update({ ...cfg, models: { ...cfg.models, [p]: model }, params });
  };

  const disconnect = (p: ByoProvider) => {
    const keys = { ...cfg.keys };
    delete keys[p];
    update({ ...cfg, keys, active: cfg.active === p ? "free" : cfg.active });
  };

  return (
    <>
      <SectionHeader
        id="orb-model-h"
        title="AI"
        hint="Who builds your worlds"
        accessory={
          <span
            aria-live="polite"
            className={`mb-0.5 flex items-center gap-1 text-[12.5px] font-medium text-[var(--ok)] transition-opacity duration-300 ${saved ? "opacity-100" : "opacity-0"}`}
          >
            {saved ? (
              <>
                <Icon name="check" size={14} strokeWidth={2.2} /> Saved
              </>
            ) : null}
          </span>
        }
      />

      <div
        className={`${groupClass} p-1.5`}
        role="radiogroup"
        aria-labelledby="orb-model-h"
      >
        <Row
          icon="sparkle"
          title="Orb's AI"
          sub="Nothing to set up"
          active={cfg.active === "free"}
          onClick={useFree}
        />

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="mt-1 flex w-full items-center gap-2 rounded-[12px] px-3 py-2.5 text-left text-[13px] font-medium text-ink-2 hover:bg-[var(--hover)] hover:text-ink"
        >
          <Icon name="key" size={15} />
          <span className="flex-1">
            Use your own AI
            {connectedCount ? ` · ${connectedCount} connected` : " · no credits used"}
          </span>
          <Icon
            name="chevron-down"
            size={15}
            className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          />
        </button>

        {open && (
          <div className="animate-fade-up mt-1 space-y-1">
            {PROVIDERS.map((p) => (
              <ProviderRow
                key={p.id}
                info={p}
                apiKey={cfg.keys[p.id] ?? ""}
                model={cfg.models[p.id] ?? DEFAULT_MODELS[p.id]}
                active={cfg.active === p.id}
                expanded={expanded === p.id}
                waiting={wanted === p.id && !cfg.keys[p.id]}
                onPick={() => pick(p.id)}
                onToggle={() => setExpanded((e) => (e === p.id ? null : p.id))}
                onKey={(k) => setKey(p.id, k)}
                onModel={(m) => setModel(p.id, m)}
                params={cfg.params?.[p.id]?.[cfg.models[p.id] ?? DEFAULT_MODELS[p.id]] ?? {}}
                onParams={(v) => setParams(p.id, cfg.models[p.id] ?? DEFAULT_MODELS[p.id], v)}
                onDisconnect={() => disconnect(p.id)}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function Radio({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full transition-colors ${on ? "bg-ink" : "shadow-[inset_0_0_0_1.5px_var(--ink-3)]"}`}
    >
      {on && <span className="h-[7px] w-[7px] rounded-full bg-paper" />}
    </span>
  );
}

function Row({
  icon,
  title,
  sub,
  active,
  onClick,
}: {
  icon: IconName;
  title: string;
  sub: string;
  active: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-[14px] px-3 py-3 text-left transition-colors ${active ? "bg-[var(--glass-bg-strong)] shadow-[0_1px_3px_rgba(16,16,40,.08)]" : "hover:bg-[var(--hover)]"}`}
    >
      <Radio on={active} />
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white [background:var(--iris)]">
        <Icon name={icon} size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-semibold text-ink">
          {title}
        </span>
        <span className="block text-[12.5px] text-ink-2">{sub}</span>
      </span>
    </button>
  );
}

function ProviderRow({
  info,
  apiKey,
  model,
  active,
  expanded,
  waiting,
  onPick,
  onToggle,
  onKey,
  onModel,
  params,
  onParams,
  onDisconnect,
}: {
  info: ProviderInfo;
  apiKey: string;
  model: string;
  active: boolean;
  expanded: boolean;
  waiting: boolean;
  onPick(): void;
  onToggle(): void;
  onKey(k: string): void;
  onModel(m: string): void;
  params: Record<string, string>;
  onParams(v: Record<string, string>): void;
  onDisconnect(): void;
}) {
  const ids = useId();
  const keyRef = useRef<HTMLInputElement>(null);
  const [keyDraft, setKeyDraft] = useState(apiKey);
  const [show, setShow] = useState(false);
  const live = useCursorModels(info.id === "cursor" && expanded ? apiKey : "");
  const choices: ModelChoice[] = live
    ? [...live]
        .sort((a, b) => (a.id === DEFAULT_MODELS.cursor ? -1 : b.id === DEFAULT_MODELS.cursor ? 1 : 0))
        .map((m) => ({ id: m.id, label: m.name, note: m.id === DEFAULT_MODELS.cursor ? "Recommended" : undefined }))
    : info.models;
  const options = info.id === "cursor" ? (live?.find((m) => m.id === model)?.options ?? []) : info.id === "openrouter" ? [] : [EFFORT];
  const known = choices.some((m) => m.id === model) || info.models.some((m) => m.id === model);
  const [custom, setCustom] = useState(!known);
  const [customDraft, setCustomDraft] = useState(known ? "" : model);
  const connected = !!apiKey;

  useEffect(() => {
    if (expanded && !connected) keyRef.current?.focus();
  }, [expanded, connected]);

  // Save the key shortly after typing stops (and on blur).
  useEffect(() => {
    if (keyDraft.trim() === apiKey) return;
    const t = setTimeout(() => onKey(keyDraft), 500);
    return () => clearTimeout(t);
  }, [keyDraft, apiKey, onKey]);

  const label = choices.find((m) => m.id === model)?.label ?? info.models.find((m) => m.id === model)?.label ?? model;

  return (
    <div
      className={`rounded-[14px] transition-colors ${active ? "bg-[var(--glass-bg-strong)] shadow-[0_1px_3px_rgba(16,16,40,.08)]" : ""}`}
    >
      <div className="flex items-center">
        <button
          type="button"
          role="radio"
          aria-checked={active}
          onClick={onPick}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-[14px] px-3 py-2.5 text-left hover:bg-[var(--hover)]"
        >
          <Radio on={active} />
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--field-bg)] text-ink">
            <Icon name={info.icon} size={15} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-medium text-ink">
              {info.name}
            </span>
            <span className="block truncate text-[12px] text-ink-2">
              {connected ? (
                <span className="text-[var(--ok)]">Connected · {label}</span>
              ) : waiting ? (
                "Paste a key to use it"
              ) : (
                info.blurb
              )}
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={`${info.name} settings`}
          className="mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-3 hover:bg-[var(--hover)] hover:text-ink"
        >
          <Icon
            name="chevron-down"
            size={15}
            className={`transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
          />
        </button>
      </div>

      {expanded && (
        <div className="animate-fade-up space-y-2.5 px-3 pt-1 pb-3">
          <div>
            <div className="mb-1 flex items-center justify-between px-0.5">
              <label
                htmlFor={`${ids}-key`}
                className="text-[12px] font-medium text-ink-2"
              >
                API key
              </label>
              <a
                href={info.keyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-0.5 text-[12px] text-ink-2 hover:text-ink hover:underline"
              >
                Get a key <Icon name="external" size={12} />
              </a>
            </div>
            <div className="relative">
              <input
                id={`${ids}-key`}
                ref={keyRef}
                type={show ? "text" : "password"}
                value={keyDraft}
                placeholder={info.keyPlaceholder}
                onChange={(e) => setKeyDraft(e.target.value)}
                onBlur={() => keyDraft.trim() !== apiKey && onKey(keyDraft)}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className={`${fieldClass} pr-10`}
              />
              <button
                type="button"
                onClick={() => setShow((v) => !v)}
                aria-label={show ? "Hide key" : "Show key"}
                className="absolute top-1/2 right-1.5 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-ink-3 hover:text-ink"
              >
                <Icon name="eye" size={15} />
              </button>
            </div>
          </div>

          <div>
            <label
              htmlFor={`${ids}-model`}
              className="mb-1 block px-0.5 text-[12px] font-medium text-ink-2"
            >
              Model
            </label>
            <div className="relative">
              <select
                id={`${ids}-model`}
                value={custom ? CUSTOM : model}
                onChange={(e) => {
                  if (e.target.value === CUSTOM) setCustom(true);
                  else {
                    setCustom(false);
                    onModel(e.target.value);
                  }
                }}
                className={`${fieldClass} appearance-none pr-8`}
                style={{ backgroundImage: "none" }}
              >
                {choices.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                    {m.note ? ` — ${m.note}` : ""}
                  </option>
                ))}
                <option value={CUSTOM}>Custom model id…</option>
              </select>
              <Icon
                name="chevron-down"
                size={14}
                className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-ink-3"
              />
            </div>
            {custom && (
              <input
                value={customDraft}
                onChange={(e) => setCustomDraft(e.target.value)}
                onBlur={() => customDraft.trim() && onModel(customDraft.trim())}
                onKeyDown={(e) =>
                  e.key === "Enter" &&
                  customDraft.trim() &&
                  onModel(customDraft.trim())
                }
                placeholder="model id"
                aria-label="Custom model id"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className={`${fieldClass} mt-1.5`}
              />
            )}
          </div>

          {(!custom || info.id !== "cursor") &&
            options.map((o) => {
              const current = params[o.id] ?? o.default ?? (o.values.some((v) => v.value === "medium") ? "medium" : o.values[0]?.value);
              return (
                <div key={o.id}>
                  <div className="mb-1 px-0.5 text-[12px] font-medium text-ink-2">{o.name}</div>
                  <div role="radiogroup" aria-label={o.name} className="flex flex-wrap gap-1">
                    {o.values.map((v) => {
                      const on = v.value === current;
                      return (
                        <button
                          key={v.value}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          onClick={() => onParams({ ...params, [o.id]: v.value })}
                          className={`h-8 rounded-full px-3 text-[12.5px] font-medium transition-colors ${on ? "bg-ink text-paper" : "bg-[var(--field-bg)] text-ink-2 hover:text-ink"}`}
                        >
                          {v.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}

          <div className="flex items-start justify-between gap-3">
            <p className="flex gap-1.5 text-[11.5px] leading-snug text-ink-3">
              <Icon name="lock" size={12} className="mt-[1px] shrink-0" />
              {info.privacy}
            </p>
            {connected && (
              <button
                type="button"
                onClick={() => {
                  setKeyDraft("");
                  onDisconnect();
                }}
                className="shrink-0 text-[12px] font-medium text-[var(--bad)] hover:underline"
              >
                Disconnect
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface ModelOption {
  id: string;
  name: string;
  values: Array<{ value: string; label: string }>;
  default?: string;
}

interface LiveModel {
  id: string;
  name: string;
  options: ModelOption[];
}
const liveCache = new Map<string, LiveModel[]>();

/** Cursor's live model catalog for a key (via Orb's relay), or null while unknown/unavailable. */
function useCursorModels(apiKey: string): LiveModel[] | null {
  const [models, setModels] = useState<LiveModel[] | null>(() => (apiKey ? (liveCache.get(apiKey) ?? null) : null));
  useEffect(() => {
    if (!apiKey) return;
    if (liveCache.has(apiKey)) {
      setModels(liveCache.get(apiKey)!);
      return;
    }
    const ctl = new AbortController();
    fetch("/api/cursor/models", { headers: deviceHeaders({ "x-orb-cursor-key": apiKey }), signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { models?: LiveModel[] } | null) => {
        if (j?.models?.length) {
          liveCache.set(apiKey, j.models);
          setModels(j.models);
        }
      })
      .catch(() => {});
    return () => ctl.abort();
  }, [apiKey]);
  return apiKey ? models : null;
}
