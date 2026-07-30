import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Cpu, Download, GraduationCap, Loader2, RotateCcw, Trash2 } from 'lucide-react';
import { usePrefs } from '../lib/prefs';
import { cn } from '../lib/cn';
import { LAYOUTS, THEMES } from '../lib/themes';
import { AutoTextarea, Section, Select, Slider, TagEditor, Toggle } from '../components/ui/controls';
import { useModelStore } from '../lib/models/registry';
import { EMBEDDING_MODELS, LLM_MODELS } from '../lib/models/catalog';
import { CLOUD_PROVIDER_INFO, CLOUD_PROVIDERS, cloudModelFor, listModels } from '../lib/models/cloud';
import type { CloudModel } from '../lib/models/cloud';
import { PROMPT_KINDS, PROMPT_META, effectivePromptPart, normalizePromptOverride } from '../lib/models/prompts';
import { warmupEmbeddings } from '../lib/models/embeddings';
import { trainFromHistory } from '../lib/ranking/train';
import { loadModel, MIN_TRAIN_SAMPLES, MIN_TRAIN_POSITIVES } from '../lib/ranking/logistic';
import { rankerGate, rankerTrained } from '../lib/ranking/strategies';
import { clearAllData, eventCount } from '../lib/interactions';
import { READER_PROXIES } from '../lib/hn/article';
import type { ReaderProxy } from '../lib/hn/article';
import { unhideAll, useHiddenCount } from '../hooks/useLocalData';
import { useCanInstall } from '../hooks/useCanInstall';
import { isStandalone, promptInstall } from '../lib/pwaInstall';
import { timeAgo } from '../lib/time';
import WeightSliders from '../components/ranking/WeightSliders';
import CachedModels from '../components/CachedModels';
import DataManager from '../components/DataManager';
import SignalsDialog from '../components/SignalsDialog';
import HiddenDialog from '../components/HiddenDialog';
import HnAccount from '../components/layout/HnAccount';
import type { FeedKind, TextSize, Theme } from '../types';

// The proxy's own host, derived from the URL it builds (source of truth = article.ts).
function proxyHost(p: ReaderProxy): string {
  try {
    return new URL(p.build('https://example.com/')).host;
  } catch {
    return '';
  }
}

export default function Settings() {
  const prefs = usePrefs();
  const qc = useQueryClient();
  const embeddings = useModelStore((s) => s.embeddings);
  const llm = useModelStore((s) => s.llm);
  // Reflect the real adapter probe, not just the API's presence — optimistic while
  // the async probe is still 'unknown' so we don't flash "No WebGPU".
  const gpu = useModelStore((s) => s.webgpu) !== 'unavailable';

  const countQ = useQuery({ queryKey: ['eventCount'], queryFn: eventCount });

  const [training, setTraining] = useState(false);
  const [trainMsg, setTrainMsg] = useState('');
  const [embLoading, setEmbLoading] = useState(false);
  const [llmLoading, setLlmLoading] = useState(false);

  const modelQ = useQuery({ queryKey: ['ranker'], queryFn: loadModel });
  const hiddenCount = useHiddenCount();

  const doTrain = async () => {
    setTraining(true);
    setTrainMsg('');
    try {
      const res = await trainFromHistory();
      // Report the clause that actually failed (see `rankerGate`) rather than always blaming the
      // sample count — a degenerate fit is not something more reading fixes.
      const gate = rankerGate(res.model);
      const notYet =
        gate === 'degenerate'
          ? "It can't personalize yet: your activity so far doesn't separate the stories you engage with from the ones you skip, so there's no pattern to fit."
          : `It'll start personalizing once you have ${MIN_TRAIN_SAMPLES}+ interactions including ${MIN_TRAIN_POSITIVES}+ stories you engaged with.`;
      setTrainMsg(
        `Trained on ${res.positives} liked + ${res.negatives} skipped items (total ${res.model.n}). ` +
          (!prefs.useLearnedRanker
            ? "Turn on “Use learned reranker” above to apply it to your For You feed."
            : gate === 'trained'
              ? "It's now personalizing your For You feed."
              : notYet)
      );
      await qc.invalidateQueries({ queryKey: ['ranker'] });
    } catch (err) {
      setTrainMsg(`Training failed: ${String(err)}`);
    } finally {
      setTraining(false);
    }
  };

  const loadEmb = async () => {
    setEmbLoading(true);
    try {
      await warmupEmbeddings(prefs.embeddingModel);
    } finally {
      setEmbLoading(false);
    }
  };

  // Cloud model lists fetched with the user's key (transient — not persisted; the CHOICE
  // is persisted in prefs.cloudModels). Keyed by provider.
  const [cloudModelList, setCloudModelList] = useState<Record<string, CloudModel[]>>({});
  const [cloudModelsLoading, setCloudModelsLoading] = useState(false);
  const [cloudModelsErr, setCloudModelsErr] = useState('');
  const [showSignals, setShowSignals] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [searchParams] = useSearchParams();
  const canInstall = useCanInstall();

  // Deep-link: other surfaces link here with ?section=<id> (e.g. the AI summary's "Edit
  // system instruction" → ai-prompts, the For You "warming up" banner's "tune ranking" →
  // ranking) — scroll to that section instead of dumping the user at the top of Settings,
  // and focus its first field where useful.
  useEffect(() => {
    const section = searchParams.get('section');
    if (!section) return;
    const el = document.getElementById(section);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (section === 'ai-prompts') el.querySelector('textarea')?.focus();
  }, [searchParams]);

  const loadCloudModels = async () => {
    const provider = prefs.llmProvider;
    if (provider === 'local') return;
    const key = prefs.apiKeys[provider]?.trim();
    if (!key) {
      setCloudModelsErr('Enter an API key first.');
      return;
    }
    setCloudModelsLoading(true);
    setCloudModelsErr('');
    try {
      const models = await listModels(provider, key);
      setCloudModelList((m) => ({ ...m, [provider]: models }));
      if (!models.length) setCloudModelsErr('No compatible models found for this key.');
    } catch (err) {
      setCloudModelsErr(String(err instanceof Error ? err.message : err));
    } finally {
      setCloudModelsLoading(false);
    }
  };

  const loadLlm = async () => {
    setLlmLoading(true);
    try {
      const { getEngine } = await import('../lib/models/llm');
      await getEngine(prefs.llmModel);
    } catch {
      // status surfaced via store
    } finally {
      setLlmLoading(false);
    }
  };

  const doClear = async () => {
    if (!confirm('Delete all local data (history, saved, models, cache)? This cannot be undone.')) {
      return;
    }
    await clearAllData();
    await qc.invalidateQueries();
    setTrainMsg('');
  };

  return (
    <main className="mx-auto max-w-3xl px-3 py-5 sm:px-4 lg:max-w-5xl">
      <h1 className="mb-4 text-xl font-semibold">Settings &amp; models</h1>
      <div className="lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-6">
        <SettingsToc />
        <div className="min-w-0 space-y-5">
          <div id="account" className="scroll-mt-20">
            <HnAccount />
          </div>

      <Section id="appearance" title="Appearance & feed">
        <Select<string>
          label="Theme design (palette + typography)"
          value={prefs.themeName}
          options={THEMES.map((t) => ({ value: t.id, label: t.label }))}
          onChange={(v) => prefs.setThemeName(v)}
        />
        <Select<string>
          label="Layout (structure)"
          value={prefs.layout}
          options={LAYOUTS.map((l) => ({ value: l.id, label: l.label }))}
          onChange={(v) => prefs.setLayout(v)}
        />
        <Select<Theme>
          label="Light / dark mode"
          value={prefs.theme}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
          onChange={(v) => prefs.setTheme(v)}
        />
        <Select<TextSize>
          label="Reading text size"
          value={prefs.textSize}
          options={[
            { value: 'sm', label: 'Small' },
            { value: 'md', label: 'Default' },
            { value: 'lg', label: 'Large' },
          ]}
          onChange={(v) => prefs.setTextSize(v)}
        />
        <Select<FeedKind>
          label="Default feed"
          value={prefs.defaultFeed}
          options={[
            { value: 'foryou', label: 'For You (recommended)' },
            { value: 'top', label: 'Top' },
            { value: 'new', label: 'New' },
            { value: 'best', label: 'Best' },
            { value: 'ask', label: 'Ask HN' },
            { value: 'show', label: 'Show HN' },
            { value: 'job', label: 'Jobs' },
          ]}
          onChange={(v) => prefs.setDefaultFeed(v)}
        />
        <Toggle
          checked={prefs.hideReadInFeed}
          onChange={(v) => prefs.set({ hideReadInFeed: v })}
          label="Hide read stories from For You"
          description="Stories you've already read drop out of For You when you reload, open a new tab, or press Refresh (they stay in the Read tab). Within a session the feed stays put — nothing is removed while you're reading."
        />
      </Section>

      <Section
        id="offline"
        title="Offline & install"
        description="Hacker Lens works offline: your Saved and Read stories stay readable without a connection. New content loads when you reconnect."
      >
        {canInstall && !isStandalone() ? (
          <button
            type="button"
            onClick={() => void promptInstall()}
            data-install-app="true"
            className="inline-flex items-center gap-2 rounded-lg border border-edge px-3 py-1.5 text-sm hover:bg-surface-2"
          >
            <Download className="size-4" /> Install for offline reading
          </button>
        ) : isStandalone() ? (
          <p className="text-sm text-muted">Installed — running as an app.</p>
        ) : (
          <p className="text-sm text-subtle">
            To install for one-tap offline access, use your browser&rsquo;s &ldquo;Install app&rdquo; / &ldquo;Add to
            Home Screen&rdquo; option.
          </p>
        )}
      </Section>

      <div id="ranking" className="scroll-mt-20">
        <Section
          title="For You ranking weights"
          description="Blend the signals used to re-rank your feed. Only affects the For You feed; changes apply when you return to it. Tip: you can also tune these live from the Tune ranking panel on For You."
        >
          <WeightSliders />
        </Section>
      </div>

      <Section
        id="reranker"
        title="Learned reranker (logistic regression)"
          description="Trains locally on your activity — the stories you read, save or hide, and the ones you scroll past — to predict what you'll engage with. When enabled, it retrains in the background; the button below forces an immediate retrain."
      >
        <Toggle
          checked={prefs.useLearnedRanker}
          onChange={(v) => prefs.set({ useLearnedRanker: v })}
          label="Use learned reranker in For You (auto-trains)"
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={doTrain}
            disabled={training}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-fg hover:opacity-90 disabled:opacity-60"
          >
            {training ? <Loader2 className="size-4 animate-spin" /> : <GraduationCap className="size-4" />}
            Retrain now
          </button>
          <span className="text-xs text-muted">
            {(() => {
              const m = modelQ.data;
              if (!m || m.n === 0) return 'Not trained yet';
              const when = m.updatedAt ? ` · ${timeAgo(Math.floor(m.updatedAt / 1000))}` : '';
              // Mirror the feed's WHOLE activeModel gate — useLearnedRanker AND rankerTrained — so
              // this never claims "Active" while the reranker is toggled off or still dormant.
              if (!prefs.useLearnedRanker) return `Off · trained on ${m.n} examples from your activity (turn on above to apply)`;
              if (rankerTrained(m)) return `Active · personalizing from ${m.n} examples from your activity${when}`;
              // Name the clause that actually failed, like the other three gate surfaces. This one
              // still collapsed everything past the sample count into "read N+ stories", so a
              // degenerate model was given advice that cannot help — and it contradicted the Retrain
              // message four lines below, which does name it.
              const gate = rankerGate(m);
              if (gate === 'degenerate')
                return `Still learning · your activity doesn't yet separate what you engage with from what you skip — not applied yet${when}`;
              return gate === 'too-few-samples'
                ? `Still learning · ${m.n}/${MIN_TRAIN_SAMPLES} examples — not applied yet`
                : `Still learning · read ${MIN_TRAIN_POSITIVES}+ stories to activate — not applied yet${when}`;
            })()}
          </span>
        </div>
        {trainMsg && <p className="text-xs text-muted">{trainMsg}</p>}
      </Section>

      <Section
        id="embeddings"
        title="Embeddings (Transformers.js)"
        description="Runs a small sentence-embedding model in your browser so For You can rank by how similar a story is to what you've been reading (the 'relevance' signal)."
      >
        <Toggle
          checked={prefs.embeddingsEnabled}
          onChange={(v) => prefs.set({ embeddingsEnabled: v })}
          label="Enable embeddings"
          description={gpu ? 'WebGPU detected — will run accelerated.' : 'No WebGPU — will run on WASM (slower).'}
        />
        <Select
          label="Embedding model"
          value={prefs.embeddingModel}
          options={EMBEDDING_MODELS}
          onChange={(v) => prefs.set({ embeddingModel: v })}
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={loadEmb}
            disabled={embLoading}
            className="inline-flex items-center gap-2 rounded-lg border border-edge px-3 py-2 text-sm hover:bg-surface-2 disabled:opacity-60"
          >
            {embLoading ? <Loader2 className="size-4 animate-spin" /> : <Cpu className="size-4" />}
            Load / test model
          </button>
          <ModelStatusLine status={embeddings.status} message={embeddings.message} progress={embeddings.progress} />
        </div>
      </Section>

      <div id="article-text" className="scroll-mt-20">
      <Section
        title="Article text (reader proxies)"
        description="By default the app can't read linked article bodies — browsers block cross-site reads (CORS), so 'content' is limited to titles, HN self-text, and comments. Turn this on to feed real page text into ranking + AI summaries. When on, the app fetches an article's text when you open it, AND speculatively prefetches a few top feed stories you haven't clicked (so the ranker has content to learn from). No setup: it uses free public reader services (AllOrigins → cors.eu.org → codetabs), trying the next if one is down."
      >
        <Toggle
          checked={prefs.fetchArticleText}
          onChange={(v) => prefs.set({ fetchArticleText: v })}
          label="Fetch linked-article text (free reader services)"
          description="Off by default. Works out of the box — no account or API key."
        />
        <div className="rounded-lg border border-border bg-surface-2 p-2.5 text-xs">
          <p className="mb-1.5 font-medium text-fg">Reader proxies (tried in this order):</p>
          <ol className="space-y-1">
            {READER_PROXIES.map((p, i) => (
              <li key={p.name} className="flex items-baseline gap-2">
                <span className="text-muted tabular-nums">{i + 1}.</span>
                <span className="font-medium text-fg">{p.name}</span>
                <span className="truncate text-muted">{proxyHost(p)}</span>
              </li>
            ))}
          </ol>
          <p className="mt-1.5 text-muted">
            The first that answers is used; if it&apos;s down/rate-limited the next is tried. Whichever
            served the text is shown on each summary as “Based on … · via &lt;proxy&gt;”, with a link to the
            source and the extracted text.
          </p>
        </div>
        {prefs.fetchArticleText && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-800 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              Privacy tradeoff: article URLs are sent to a free third-party reader service — not just ones you
              open, but also a few top feed stories the app prefetches for ranking. It&apos;s the most
              revealing of the app&apos;s few non-local calls; the others are story favicons (on by default,
              below), downloading AI model weights, and a cloud AI provider if you configure one. Ranking,
              training and your history never leave your browser.
            </span>
          </div>
        )}
      </Section>
      </div>

      <Section
        id="privacy"
        title="Privacy"
        description="Hacker Lens runs entirely in your browser — reading history, ranking, and personalization never leave your device. The two always-relevant exceptions are toggles here: linked-article text (above) and story favicons. AI-related calls (the one-time on-device model download, and a cloud provider if you configure one) are described in the AI section above; read-aloud uses your platform's voice, which may be a network voice."
      >
        <Toggle
          checked={prefs.remoteFavicons}
          onChange={(v) => prefs.set({ remoteFavicons: v })}
          label="Load story favicons from Google's favicon service"
          description="On by default. Turn off for strict privacy: favicons show as letter monograms only, so the domains of stories you view are never sent to Google's favicon service."
        />
      </Section>

      <Section
        id="ai-summaries"
        title="AI summaries"
        description="Powers TL;DRs and discussion summaries. Use the on-device model (your content never leaves the browser; needs WebGPU, and the one-time weight download comes from huggingface.co) or bring your own cloud API key (faster/stronger, but sends the summary content to that provider)."
      >
        <Select
          label="AI provider"
          value={prefs.llmProvider}
          options={[
            { value: 'local', label: 'On-device (WebLLM — private, no key)' },
            ...CLOUD_PROVIDERS.map((p) => ({ value: p, label: `${CLOUD_PROVIDER_INFO[p].label} (your API key)` })),
          ]}
          onChange={(v) => {
            prefs.set({ llmProvider: v as typeof prefs.llmProvider });
            setCloudModelsErr(''); // don't leak one provider's load-error onto another
          }}
        />
        <Toggle
          checked={prefs.showAiSummaries}
          onChange={(v) => prefs.set({ showAiSummaries: v })}
          label="Show AI summary controls in comments"
        />

        {prefs.llmProvider === 'local' ? (
          <>
            {!gpu && (
              <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-xs font-medium text-red-800 dark:text-red-200">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                WebGPU isn&apos;t available in this browser, so the on-device model can&apos;t run. Try recent
                Chrome/Edge, or pick a cloud provider above.
              </div>
            )}
            <Toggle
              checked={prefs.llmEnabled}
              onChange={(v) => prefs.set({ llmEnabled: v })}
              label="Enable on-device model"
            />
            <Select
              label="On-device model"
              value={prefs.llmModel}
              options={LLM_MODELS.map((m) => ({ value: m.id, label: m.label }))}
              onChange={(v) => prefs.set({ llmModel: v })}
            />
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={loadLlm}
                disabled={llmLoading || !gpu}
                className="inline-flex items-center gap-2 rounded-lg border border-edge px-3 py-2 text-sm hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {llmLoading ? <Loader2 className="size-4 animate-spin" /> : <Cpu className="size-4" />}
                Load model
              </button>
              <ModelStatusLine status={llm.status} message={llm.message} progress={llm.progress} />
            </div>
          </>
        ) : (
          <div className="space-y-2">
            <label className="block text-sm">
              <span className="mb-1 block font-medium">{CLOUD_PROVIDER_INFO[prefs.llmProvider].label} API key</span>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={prefs.apiKeys[prefs.llmProvider]}
                placeholder={CLOUD_PROVIDER_INFO[prefs.llmProvider].keyPlaceholder}
                onChange={(e) => {
                  prefs.set({ apiKeys: { ...prefs.apiKeys, [prefs.llmProvider]: e.target.value } });
                  setCloudModelsErr(''); // a stale "invalid key" error shouldn't linger while editing
                }}
                className="w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
              />
            </label>
            <p className="text-xs text-muted">
              <a
                href={CLOUD_PROVIDER_INFO[prefs.llmProvider].keysUrl}
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline"
              >
                Get an API key →
              </a>
            </p>

            {/* Model picker — populated by querying the provider's model list with the key. */}
            <div className="space-y-1">
              <div className="flex items-end gap-2">
                <label className="block flex-1 text-sm">
                  <span className="mb-1 block font-medium">Model</span>
                  <select
                    aria-label="AI model"
                    value={cloudModelFor(prefs.llmProvider, prefs.cloudModels[prefs.llmProvider])}
                    onChange={(e) => prefs.set({ cloudModels: { ...prefs.cloudModels, [prefs.llmProvider]: e.target.value } })}
                    className="w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
                  >
                    {(() => {
                      // Always include the CHOSEN model as an option — otherwise, after a
                      // reload (the fetched list is transient, not persisted), a controlled
                      // <select> whose value matches no <option> silently renders the first
                      // one, so the picker showed the DEFAULT while summaries used the saved
                      // choice (used ≠ displayed). Ensure value ∈ options.
                      const chosen = cloudModelFor(prefs.llmProvider, prefs.cloudModels[prefs.llmProvider]);
                      const loaded = cloudModelList[prefs.llmProvider] ?? [];
                      const opts = loaded.length
                        ? [...loaded]
                        : [{ id: CLOUD_PROVIDER_INFO[prefs.llmProvider].defaultModel, label: `${CLOUD_PROVIDER_INFO[prefs.llmProvider].defaultModel} (default)` }];
                      if (!opts.some((m) => m.id === chosen)) opts.unshift({ id: chosen, label: chosen });
                      return opts.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ));
                    })()}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={loadCloudModels}
                  disabled={cloudModelsLoading || !prefs.apiKeys[prefs.llmProvider].trim()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-edge px-3 py-2 text-sm hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {cloudModelsLoading ? <Loader2 className="size-4 animate-spin" /> : null}
                  Load models
                </button>
              </div>
              {cloudModelsErr ? (
                <p className="text-xs font-medium text-red-700 dark:text-red-300">{cloudModelsErr}</p>
              ) : cloudModelList[prefs.llmProvider]?.length ? (
                <p className="text-xs text-subtle">{cloudModelList[prefs.llmProvider].length} models available for your key.</p>
              ) : (
                <p className="text-xs text-subtle">Load models to choose which one to use (until then, the default is used).</p>
              )}
            </div>
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-800 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                <span className="font-medium">Privacy:</span> summaries you request send the story title, top
                comments {prefs.fetchArticleText ? '+ fetched article text ' : ''}and your API key directly from
                your browser to {CLOUD_PROVIDER_INFO[prefs.llmProvider].label}. The key is stored only in this
                browser (localStorage). With the on-device model your content never leaves the browser — only the
                one-time model download touches the network.
              </span>
            </div>
          </div>
        )}
      </Section>

      <div id="ai-prompts" className="scroll-mt-20">
      <Section
        title="AI prompts (advanced)"
        description="The EXACT instructions sent to the model for each summary type — BOTH the system instruction and the user-message template. Each field is pre-filled with the current prompt (the built-in default until you change it); edit it in place, or use Reset to restore the default. The template's {placeholders} are filled with the story data at request time. Changing either re-summarizes."
      >
        {PROMPT_KINDS.map((k) => (
          <div key={k} className="space-y-2 rounded-lg border border-border bg-surface-2 p-3">
            <div>
              <div className="text-sm font-semibold">{PROMPT_META[k].label}</div>
              <p className="text-xs text-muted">{PROMPT_META[k].description}</p>
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label htmlFor={`sys-${k}`} className="text-xs font-medium text-muted">System instruction</label>
                {prefs.prompts[k].system && (
                  <button
                    type="button"
                    onClick={() => prefs.set({ prompts: { ...prefs.prompts, [k]: { ...prefs.prompts[k], system: '' } } })}
                    className="text-xs text-accent hover:underline"
                  >
                    Reset
                  </button>
                )}
              </div>
              <AutoTextarea
                id={`sys-${k}`}
                rows={4}
                maxPx={360}
                value={effectivePromptPart(k, 'system', prefs.prompts)}
                onChange={(e) => prefs.set({ prompts: { ...prefs.prompts, [k]: { ...prefs.prompts[k], system: normalizePromptOverride(k, 'system', e.target.value) } } })}
                className="w-full rounded-lg border border-edge bg-surface px-3 py-2 text-xs outline-none focus:border-accent"
              />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label htmlFor={`usr-${k}`} className="text-xs font-medium text-muted">User-message template</label>
                {prefs.prompts[k].user && (
                  <button
                    type="button"
                    onClick={() => prefs.set({ prompts: { ...prefs.prompts, [k]: { ...prefs.prompts[k], user: '' } } })}
                    className="text-xs text-accent hover:underline"
                  >
                    Reset
                  </button>
                )}
              </div>
              <AutoTextarea
                id={`usr-${k}`}
                rows={5}
                maxPx={460}
                value={effectivePromptPart(k, 'user', prefs.prompts)}
                onChange={(e) => prefs.set({ prompts: { ...prefs.prompts, [k]: { ...prefs.prompts[k], user: normalizePromptOverride(k, 'user', e.target.value) } } })}
                className="w-full rounded-lg border border-edge bg-surface px-3 py-2 font-mono text-xs leading-relaxed outline-none focus:border-accent"
              />
              <p className="text-[11px] text-muted">
                Placeholders:{' '}
                {PROMPT_META[k].placeholders.map((p) => (
                  <code key={p} className="mr-1 rounded bg-surface px-1 py-0.5">{p}</code>
                ))}
              </p>
            </div>
          </div>
        ))}
      </Section>
      </div>

      <Section
        id="models"
        title="Cached models & storage"
        description="Downloaded model weights are cached in your browser so they don't re-download. They're large — remove any you don't need to free space."
      >
        <CachedModels />
      </Section>

      <Section id="filters" title="Filters">
        <Slider
          label={`Minimum points: ${prefs.minPoints}`}
          value={prefs.minPoints}
          min={0}
          max={200}
          step={5}
          decimals={0}
          onChange={(v) => prefs.set({ minPoints: v })}
        />
        <TagEditor
          label="Boost keywords (in title)"
          values={prefs.keywordsBoost}
          onChange={(v) => prefs.set({ keywordsBoost: v })}
          placeholder="e.g. rust, llm, postgres"
        />
        <TagEditor
          label="Mute keywords"
          values={prefs.keywordsMute}
          onChange={(v) => prefs.set({ keywordsMute: v })}
          placeholder="hide stories with these words"
        />
        <TagEditor
          label="Followed domains"
          values={prefs.followedDomains}
          onChange={(v) => prefs.set({ followedDomains: v })}
          placeholder="e.g. github.com"
        />
        <TagEditor
          label="Muted domains"
          values={prefs.mutedDomains}
          onChange={(v) => prefs.set({ mutedDomains: v })}
          placeholder="e.g. example.com"
        />
        <TagEditor
          label="Followed users"
          values={prefs.followedUsers}
          onChange={(v) => prefs.set({ followedUsers: v })}
          placeholder="HN usernames (case-sensitive)"
          lowercase={false}
        />
        <TagEditor
          label="Muted users"
          values={prefs.mutedUsers}
          onChange={(v) => prefs.set({ mutedUsers: v })}
          placeholder="HN usernames (case-sensitive)"
          lowercase={false}
        />
      </Section>

      <Section id="data" title="Data" description="Everything is stored locally in your browser (IndexedDB + localStorage). Delete by type below, or clear it all.">
        <button
          type="button"
          onClick={() => setShowSignals(true)}
          className="inline-flex items-center gap-1 text-sm text-accent hover:underline"
        >
          {(countQ.data ?? 0).toLocaleString()} interaction signals recorded — view
        </button>
        {showSignals && <SignalsDialog onClose={() => setShowSignals(false)} />}

        {/* The count DRILLS IN, matching its sibling 43px above ("N interaction signals recorded —
            view"). It used to be dead text whose only neighbour was a destructive bulk action, while
            the per-item viewer lived 475px further down — so the obvious thing to click on noticing
            "12 hidden stories" was "Unhide all", which discards every not-interested downvote at
            once and retrains the ranker on stories the reader still doesn't want. Same data, same
            page, two opposite affordances. Bulk stays as the escape hatch, demoted. */}
        <div className="flex flex-wrap items-center gap-2">
          {hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => setShowHidden(true)}
              className="inline-flex items-center gap-1 text-sm text-accent hover:underline"
            >
              {hiddenCount} hidden {hiddenCount === 1 ? 'story' : 'stories'} — view
            </button>
          ) : (
            <span className="text-sm text-muted">No hidden stories</span>
          )}
          {showHidden && <HiddenDialog onClose={() => setShowHidden(false)} />}
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => void unhideAll()}
              className="rounded-lg border border-edge px-3 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg"
            >
              Unhide all
            </button>
          )}
        </div>

        <DataManager />

        <div className="flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            onClick={() => {
              if (confirm('Reset all settings (weights, filters, models, follows) to defaults?')) prefs.reset();
            }}
            className="inline-flex items-center gap-2 rounded-lg border border-edge px-3 py-2 text-sm hover:bg-surface-2"
          >
            <RotateCcw className="size-4" /> Reset all settings
          </button>
          <button
            type="button"
            onClick={doClear}
            className="inline-flex items-center gap-2 rounded-lg border border-edge px-3 py-2 text-sm text-red-700 dark:text-red-300 hover:bg-red-500/10"
          >
            <Trash2 className="size-4" /> Clear all local data
          </button>
        </div>
      </Section>
        </div>
      </div>
    </main>
  );
}

const SETTINGS_SECTIONS: { id: string; label: string }[] = [
  { id: 'account', label: 'Account' },
  { id: 'appearance', label: 'Appearance & feed' },
  { id: 'offline', label: 'Offline & install' },
  { id: 'ranking', label: 'Ranking weights' },
  { id: 'reranker', label: 'Learned reranker' },
  { id: 'embeddings', label: 'Embeddings' },
  { id: 'article-text', label: 'Article text' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'ai-summaries', label: 'AI summaries' },
  { id: 'ai-prompts', label: 'AI prompts' },
  { id: 'models', label: 'Cached models' },
  { id: 'filters', label: 'Filters' },
  { id: 'data', label: 'Data' },
];

// Table of contents for the Settings page: a sticky rail (lg+) / horizontally-scrollable
// bar (mobile) that jumps to each section and highlights the one currently in view.
function SettingsToc() {
  const [active, setActive] = useState(SETTINGS_SECTIONS[0].id);
  useEffect(() => {
    const obs = new IntersectionObserver(
      (entries) => {
        const vis = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (vis[0]) setActive(vis[0].target.id);
      },
      // Trigger when a section's top is in the upper third of the viewport.
      { rootMargin: '-72px 0px -66% 0px' }
    );
    for (const s of SETTINGS_SECTIONS) {
      const el = document.getElementById(s.id);
      if (el) obs.observe(el);
    }
    return () => obs.disconnect();
  }, []);
  const go = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActive(id);
  };
  return (
    <nav
      aria-label="Settings sections"
      className="mb-4 lg:sticky lg:top-[4.5rem] lg:mb-0 lg:self-start"
    >
      <p className="mb-2 hidden text-xs font-semibold uppercase tracking-wide text-subtle lg:block">On this page</p>
      <ul className="-mx-1 flex flex-wrap gap-1 px-1 pb-1 lg:mx-0 lg:flex-col lg:flex-nowrap lg:px-0 lg:pb-0">
        {SETTINGS_SECTIONS.map((s) => (
          <li key={s.id} className="shrink-0 lg:shrink">
            <button
              type="button"
              onClick={() => go(s.id)}
              aria-current={active === s.id ? 'true' : undefined}
              className={cn(
                'w-full whitespace-nowrap rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors',
                active === s.id
                  ? 'bg-accent/15 font-semibold text-fg ring-1 ring-accent'
                  : 'text-muted hover:bg-surface-2 hover:text-fg'
              )}
            >
              {s.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function ModelStatusLine({
  status,
  message,
  progress,
}: {
  status: string;
  message: string;
  progress: number;
}) {
  // data-model-status is a stable hook for the WebGPU harnesses. They previously polled this with
  // getByText(/loading|ready|error|.../) scoped to the surrounding section, which also matches
  // ordinary prose — the privacy disclosure's "downloading AI model weights" contains "loading",
  // so whenever the reader-proxy toggle was on the harness read that paragraph as the model status
  // and waited out its full 10-minute deadline. Target the element, not the words.
  if (status === 'idle')
    return (
      <span data-model-status="idle" className="text-xs text-muted">
        Not loaded
      </span>
    );
  return (
    <span data-model-status={status} className="text-xs text-muted">
      {status === 'loading' ? `${Math.round(progress * 100)}% · ${message}` : `${status}${message ? ` · ${message}` : ''}`}
    </span>
  );
}
