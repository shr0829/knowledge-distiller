import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Checkbox, Field, Input, Select, Spinner, Switch, Tab, TabList } from '@fluentui/react-components';
import { ArrowClockwise20Regular, ArrowDownload20Regular, ChevronRight16Regular, Dismiss20Regular, DocumentSearch20Regular, Link20Regular, Play20Regular, Search20Regular } from '@fluentui/react-icons';
import { api } from './api';
import { errorText } from './utils';
import { EvidencePanel } from './Evidence';
import type { NoteEvidence } from './Evidence';
import type { Project } from './types';
import './Knowledge.css';

type Source = { id: string; locator: string; kind: string; revision: string; chars: number; processed: boolean; content?: string };
type Build = { id: string; status: string; source_ids: string[]; proposal_ids: string[]; error?: string; review_progress?: Record<string, number>; review_complete?: boolean };
type Overview = { sources: Source[]; source_total: number; next_offset: number | null; builds: Build[]; pending_sources: number; notes: number; knowledge_dir: string; scan?: { skipped: { path: string; reason: string }[]; truncated: boolean; files: number; sessions: number } };
type Engine = { installed: boolean; purpose: string };
type ProviderState = { status: string; mode?: string; stale?: boolean; error?: string; indexed_at?: string; diagnostics?: { semantic_error?: string; semantic_scope?: string; semantic_documents?: number; pending?: number } };
type FineState = { status?: string; prepared_parts?: number; storage_parts?: number; blocks?: number; diagnostics?: { pending?: number }; semantic_ready?: boolean };
type Engines = { qmd: Engine; ohs: Engine; projects: Record<string, Record<string, ProviderState>>; fine_projects?: Record<string, FineState> };
type Hit = { id: string; project: string; project_id: string; title: string; path: string; content: string; layer: string; engines: string[] };
type SearchResult = { hits: Hit[]; engines: string[]; warnings: string[]; metrics?: { candidates: number; bodies_loaded: number; returned_bytes: number; cache_hits: number } };
type Graph = { nodes: { id: string; project: string; title: string; path: string }[]; edges: { source: string; target: string; kind: string }[] };
type PipelineSettings = { enabled: boolean; interval_seconds: number; auto_prepare: boolean; auto_index: boolean; auto_compile: boolean; batch_size: number };
type LayerJob = { id: string; status: string; phase: string; source_ids: string[]; extraction_ids: string[]; result_ids: string[]; attempts?: number; error?: string };
type Material = { id: string; title: string; content: string; kind: string; status: string; uncertain: boolean; source_ids: string[]; scope?: string; derived_from?: string[]; extraction_ids?: string[]; citations?: { source_id: string; quote: string }[] };
type LayerOverview = { extractions: Material[]; abstractions: Material[]; jobs: LayerJob[]; processed_sources: number; pending_sources: number };
type LayerTrace = { layer: 'extraction' | 'abstraction'; record: Material; extractions: Material[]; sources: Source[] };
type PipelineState = { settings: PipelineSettings; model_enabled: boolean; last_run?: { finished_at?: string; failed_at?: string; error?: string }; layers?: LayerOverview };

const abstractionStatuses: Record<string, string> = { pending: '待审核', applied: '已发布', discarded: '已丢弃', deferred: '已暂缓', conflict: '存在冲突' };
const previewText = (content: string, limit = 320) => content.length > limit ? `${content.slice(0, limit)}…` : content;
const layerJobStatus = (job: LayerJob, modelEnabled: boolean) => {
  if (job.status === 'completed') return `已生成 ${job.result_ids.length} 条结果`;
  if (job.status === 'running') return '后台处理中';
  if (job.status === 'error') return '处理失败';
  return modelEnabled ? '等待后台模型' : '等待模型配置';
};

export function KnowledgePage({ project, onReview }: { project: Project; onReview: () => void }) {
  const [tab, setTab] = useState('sources');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [engines, setEngines] = useState<Engines | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [source, setSource] = useState<Source | null>(null);
  const [build, setBuild] = useState<Build | null>(null);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('project');
  const [layer, setLayer] = useState('all');
  const [engine, setEngine] = useState('auto');
  const [results, setResults] = useState<SearchResult | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [filter, setFilter] = useState('');
  const [integration, setIntegration] = useState<Record<string, string> | null>(null);
  const [pipeline, setPipeline] = useState<PipelineState | null>(null);
  const [sourcePage, setSourcePage] = useState<{ sources: Source[]; total: number; offset: number; next_offset: number | null } | null>(null);
  const [sourceQuery, setSourceQuery] = useState('');
  const [evidence, setEvidence] = useState<NoteEvidence | null>(null);
  const [layerTrace, setLayerTrace] = useState<LayerTrace | null>(null);
  const reload = useCallback(async () => {
    const [o, e, p] = await Promise.all([
      api<Overview>(`/projects/${project.id}/knowledge`), api<Engines>('/retrieval/status'),
      api<PipelineState>(`/projects/${project.id}/pipeline`),
    ]);
    setOverview(o); setEngines(e); setPipeline(p);
    setSourcePage({ sources: o.sources, total: o.source_total, offset: 0, next_offset: o.next_offset });
  }, [project.id]);
  useEffect(() => { void Promise.resolve().then(reload).catch(e => setError(errorText(e))); }, [reload]);
  const run = async (name: string, action: () => Promise<void>, refreshAfter = true) => {
    setBusy(name); setError(''); setNotice('');
    try { await action(); if (refreshAfter) await reload(); } catch (e) { setError(errorText(e)); } finally { setBusy(''); }
  };
  const layerOverview = pipeline?.layers;
  const layerJobs = layerOverview?.jobs || [];
  const search = () => run('search', async () => {
    setResults(await api<SearchResult>('/knowledge/search', 'POST', {
      query, project_ids: scope === 'project' ? [project.id] : null, layer, engine,
    }));
  });
  const visible = sourcePage?.sources || [];
  const fetchSources = async (offset: number, query: string) => {
    setSourcePage(await api('/knowledge/sources', 'POST', { project_id: project.id, offset, query, limit: 100 }));
    setSourceQuery(query);
  };
  const configure = (changes: Partial<PipelineSettings>) => run('pipeline-settings', async () => {
    if (pipeline) setPipeline(await api<PipelineState>(`/projects/${project.id}/pipeline`, 'PUT', { ...pipeline.settings, ...changes }));
  });
  return <div className="knowledge-workspace">
    <div className="knowledge-heading">
      <div><h2>{project.name}</h2><p>{overview?.source_total.toLocaleString() || 0} 份原始快照 · {overview?.notes || 0} 篇已发布知识</p></div>
      <Button icon={<ArrowClockwise20Regular />} disabled={!!busy} onClick={() => void run('refresh', reload)}>刷新</Button>
    </div>
    <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(String(d.value))}>
      <Tab value="sources">三层知识链</Tab><Tab value="search">跨项目检索</Tab><Tab value="integrations">检索与 Claudian</Tab>
    </TabList>
    {error && <div role="alert" className="message error">{error}</div>}
    {notice && <div role="status" className="message success">{notice}</div>}
    {busy && <Spinner size="tiny" label={busy.startsWith('index') ? '正在更新索引，首次运行可能需要下载本地模型…' : '正在处理…'} />}
    {!overview ? <p>正在读取来源清单…</p> : tab === 'sources' ? <>
      <section className="layer-intro" aria-labelledby="layer-heading">
        <div className="layer-intro-copy"><h3 id="layer-heading">从只读快照，到可审核抽象</h3><p>原始文件和会话记录保持不变。系统先跨来源归纳材料，再从材料中生成更高层的原则，并保留每一级证据。</p></div>
        {pipeline && <div className="automation-control"><Switch label="持续自动提取" checked={pipeline.settings.enabled && pipeline.settings.auto_prepare && pipeline.settings.auto_compile} disabled={!!busy || !pipeline.model_enabled} onChange={(_, d) => void configure({ enabled: d.checked, auto_prepare: true, auto_compile: true })} /><span>{pipeline.model_enabled ? '后台模型已启用' : '先在项目设置中启用后台模型'}</span></div>}
      </section>
      <div className="layer-summary" aria-label="知识链概览">
        <div className="layer-metric layer-metric-raw"><span className="layer-metric-index">01</span><strong>{overview.source_total.toLocaleString()}</strong><span>只读原始快照</span></div>
        <ChevronRight16Regular className="layer-flow-arrow" />
        <div className="layer-metric layer-metric-material"><span className="layer-metric-index">02</span><strong>{layerOverview?.extractions.length || 0}</strong><span>跨来源材料</span><small>{layerOverview?.processed_sources || 0} 份来源已覆盖</small></div>
        <ChevronRight16Regular className="layer-flow-arrow" />
        <div className="layer-metric layer-metric-abstract"><span className="layer-metric-index">03</span><strong>{layerOverview?.abstractions.length || 0}</strong><span>可审核抽象</span><small>{layerOverview?.abstractions.filter(item => item.status === 'pending').length || 0} 项等待审核</small></div>
      </div>
      <div className="knowledge-toolbar knowledge-actions">
        <Button icon={<ArrowDownload20Regular />} disabled={!!busy} onClick={() => void run('scan', async () => {
          const scan = await api<{ files: number; sessions: number; new_versions: number }>(`/projects/${project.id}/sources/scan`, 'POST', {});
          setNotice(`已采集 ${scan.files} 个文件、${scan.sessions} 段项目会话，新增 ${scan.new_versions} 份来源版本。`);
        })}>采集原始快照</Button>
        <Button appearance="primary" icon={<Play20Regular />} disabled={!!busy || (!selected.length && !layerOverview?.pending_sources)} onClick={() => void run('extract', async () => {
          const result = await api<LayerJob>(`/projects/${project.id}/extractions`, 'POST', { source_ids: selected.length ? selected.slice(0, 20) : null, limit: selected.length ? 20 : 8 });
          if (pipeline?.model_enabled) await api(`/layer-jobs/${result.id}/compile`, 'POST', {});
          setSelected([]); setNotice(pipeline?.model_enabled ? '已完成一次跨来源提取。结果已写入第二层材料。' : '已准备跨来源提取任务，等待后台模型执行。');
        })}>{selected.length ? `提取选中来源（${Math.min(selected.length, 20)}）` : '提取新增来源'}</Button>
        {!selected.length && <span className="subtle pending-count">{layerOverview?.pending_sources || 0} 个来源待提取</span>}
        <Input aria-label="筛选来源" contentBefore={<Search20Regular />} placeholder="筛选文件或会话" value={filter} onChange={(_, d) => setFilter(d.value)} onKeyDown={e => { if (e.key === 'Enter') void run('filter', () => fetchSources(0, filter), false); }} />
        <Button disabled={!!busy} onClick={() => void run('filter', () => fetchSources(0, filter), false)}>筛选</Button>
      </div>
      <div className="layer-columns">
        <section className="layer-section layer-section-raw" aria-labelledby="raw-heading">
          <div className="layer-section-heading"><div><span className="layer-section-index">01</span><h3 id="raw-heading">原始快照</h3><p>只读文件与历史会话。勾选来源后，可将它们作为同一批上下文交给第二层。</p></div><Badge appearance="outline">不可变</Badge></div>
          <p className="subtle source-path">知识目录：<span className="path">{overview.knowledge_dir}</span></p>
          {overview.scan?.truncated && <p role="status" className="inline-status">尚有材料未扫描，下次采集会继续。</p>}
          {!!overview.scan?.skipped.length && <details className="skipped-sources"><summary>{overview.scan.skipped.length} 份材料未读取</summary><pre>{JSON.stringify(overview.scan.skipped, null, 2)}</pre></details>}
          <div className="source-workspace">
            <div className="source-list" aria-label="原始材料">
              {!visible.length ? <div className="compact-empty">尚无来源。先采集当前项目文件和匹配的历史会话。</div> : visible.map(s => <div className="source-row" key={s.id}>
                <Checkbox aria-label={`选择 ${s.locator}`} checked={selected.includes(s.id)} onChange={(_, d) => setSelected(old => d.checked ? [...old, s.id] : old.filter(id => id !== s.id))} />
                <button className="source-open" onClick={() => void run('source', async () => setSource(await api<Source>(`/sources/${s.id}`)))}>
                  <strong>{s.locator}</strong><span>{s.kind === 'conversation' ? '历史会话' : '项目文件'} · {s.chars.toLocaleString()} 字符</span>
                </button><Badge appearance="outline">只读</Badge>
              </div>)}
              {sourcePage && <div className="button-row source-pagination"><span>{sourcePage.total.toLocaleString()} 份来源，当前 {sourcePage.offset + (visible.length ? 1 : 0)}-{sourcePage.offset + visible.length}</span><Button disabled={!!busy || sourcePage.offset === 0} onClick={() => void run('source-page', () => fetchSources(Math.max(0, sourcePage.offset - 100), sourceQuery), false)}>上一页</Button><Button disabled={!!busy || sourcePage.next_offset === null} onClick={() => void run('source-page', () => fetchSources(sourcePage.next_offset!, sourceQuery), false)}>下一页</Button></div>}
            </div>
            <div className="source-reader" aria-label="来源内容">
              {source ? <><div className="source-reader-heading"><div><h3>{source.locator}</h3><p className="path">SHA-256 {source.revision.slice(0, 16)}</p></div><Button appearance="subtle" size="small" icon={<Dismiss20Regular />} aria-label="关闭原始快照" onClick={() => setSource(null)} /></div><pre>{source.content}</pre></> : <div className="compact-empty"><DocumentSearch20Regular /><p>选择来源查看原始快照。</p></div>}
            </div>
          </div>
        </section>
        <section className="layer-section layer-section-material" aria-labelledby="material-heading">
          <div className="layer-section-heading"><div><span className="layer-section-index">02</span><h3 id="material-heading">跨来源材料</h3><p>自动按主题、决策和反复出现的模式归纳，不为单个来源单独写提炼笔记。</p></div><Badge appearance="outline">自动生成</Badge></div>
          <div className="layer-jobs" aria-label="自动提取任务">
            {layerJobs.filter(job => job.phase === 'extraction').slice(-5).reverse().map(job => <div className="layer-job" key={job.id}><div><strong>{job.id.slice(0, 10)}</strong><span>{job.source_ids.length} 个来源窗口</span></div><Badge appearance="outline" color={job.status === 'completed' ? 'success' : job.status === 'error' ? 'warning' : 'informative'}>{layerJobStatus(job, !!pipeline?.model_enabled)}</Badge>{job.status !== 'completed' && <Button size="small" icon={<Play20Regular />} disabled={!!busy || !pipeline?.model_enabled || job.status === 'running'} onClick={() => void run('layer-compile', async () => { await api(`/layer-jobs/${job.id}/compile`, 'POST', {}); })}>{job.status === 'error' ? '重试' : '运行'}</Button>}{job.error && <span className="form-error">{job.error}</span>}</div>)}
            {!layerJobs.some(job => job.phase === 'extraction') && <p className="compact-empty">采集来源后，自动提取任务会显示在这里。</p>}
          </div>
          <div className="layer-items">
            {!layerOverview?.extractions.length && <p className="compact-empty">尚无第二层材料。运行一次跨来源提取后，系统会在这里保留可复用的归纳。</p>}
            {layerOverview?.extractions.slice(0, 8).map(item => <article className="layer-item" key={item.id}>
              <div className="layer-item-heading"><div><strong>{item.title}</strong>{item.uncertain && <Badge appearance="outline" color="warning">待确认</Badge>}</div><span>{item.source_ids.length} 个来源</span></div><p>{previewText(item.content)}</p>
              <Button size="small" icon={<DocumentSearch20Regular />} disabled={!!busy} onClick={() => void run('layer-trace', async () => setLayerTrace(await api<LayerTrace>(`/layers/extraction/${item.id}/trace`)), false)}>查看来源链</Button>
            </article>)}
          </div>
        </section>
        <section className="layer-section layer-section-abstract" aria-labelledby="abstract-heading">
          <div className="layer-section-heading"><div><span className="layer-section-index">03</span><h3 id="abstract-heading">更高层抽象</h3><p>在第二层材料之上提炼原则、模型和经验，生成后进入人工审核。</p></div><Badge appearance="outline">需审核</Badge></div>
          <Button appearance="primary" size="small" icon={<Play20Regular />} disabled={!!busy || !layerOverview?.extractions.length} onClick={() => void run('abstraction-prepare', async () => {
            const job = await api<LayerJob>(`/projects/${project.id}/abstractions`, 'POST', { limit: pipeline?.settings.batch_size || 4 });
            if (pipeline?.model_enabled) await api(`/layer-jobs/${job.id}/compile`, 'POST', {});
            setNotice(pipeline?.model_enabled ? '已生成第三层抽象候选，请到审核队列确认。' : '已准备抽象任务，等待后台模型执行。');
          })}>从材料生成抽象</Button>
          <div className="layer-items">
            {!layerOverview?.abstractions.length && <p className="compact-empty">尚无第三层抽象。先生成第二层材料。</p>}
            {layerOverview?.abstractions.slice(0, 8).map(item => <article className="layer-item" key={item.id}>
              <div className="layer-item-heading"><div><strong>{item.title}</strong><Badge appearance="outline" color={item.status === 'applied' ? 'success' : item.status === 'conflict' ? 'warning' : 'informative'}>{abstractionStatuses[item.status] || item.status}</Badge></div><span>{item.extraction_ids?.length || 0} 条材料</span></div><p>{previewText(item.content)}</p>
              <div className="button-row"><Button size="small" icon={<DocumentSearch20Regular />} disabled={!!busy} onClick={() => void run('layer-trace', async () => setLayerTrace(await api<LayerTrace>(`/layers/abstraction/${item.id}/trace`)), false)}>逐层溯源</Button>{item.status === 'pending' && <Button size="small" onClick={onReview}>打开审核队列</Button>}</div>
            </article>)}
          </div>
        </section>
      </div>
      <details className="build-list"><summary>兼容入口：历史直接加工任务（{overview.builds.length}）</summary>
        <p className="subtle">旧任务不会被自动管线继续创建，仅保留用于查看和维护历史数据。</p>
        {!overview.builds.length && <p className="subtle">尚未创建历史任务。</p>}
        {overview.builds.map(b => <div className="build-row" key={b.id}><span className="path">{b.id.slice(0, 10)}</span><span>{b.source_ids.length} 份材料</span><Badge appearance="outline" color={b.status === 'error' ? 'warning' : b.review_complete ? 'success' : 'informative'}>{b.status === 'submitted' ? b.review_complete ? '审核完成' : `${b.proposal_ids.length} 项待审核` : b.status === 'running' ? '提炼中' : b.status === 'error' ? '提炼失败' : '等待 Agent 提炼'}</Badge>
          {b.review_progress && <span className="subtle">已发布 {b.review_progress.applied || 0} / 已丢弃 {b.review_progress.discarded || 0}</span>}
          <Button size="small" onClick={() => setBuild(b)}>查看任务</Button>{b.status !== 'submitted' && <Button size="small" icon={<Play20Regular />} disabled={!!busy || b.status === 'running' || !pipeline?.model_enabled} onClick={() => void run('compile', async () => { setBuild(await api<Build>(`/builds/${b.id}/compile`, 'POST', {})); })}>{b.status === 'error' ? '重试提炼' : '后台提炼'}</Button>}{b.proposal_ids.length > 0 && <Button size="small" onClick={onReview}>审核候选</Button>}{b.error && <p className="form-error">{b.error}</p>}</div>)}
        {build && <div className="build-instructions"><h3>交给当前 Codex 或 Claudian</h3><p>读取历史任务并根据原文提交候选；每项候选会进入审核队列。</p><pre>{`使用 get_knowledge_build 读取任务 ${build.id}。\n检索已有知识，提炼这些来源，并通过 submit_knowledge_build 提交候选。\n每项提供 source_ids 和 source 原文引文；跨项目关联填写 related_notes。`}</pre></div>}
      </details>
      {layerTrace && <section className="layer-trace" aria-label="分层溯源">
        <div className="layer-trace-heading"><div><span className="layer-section-index">溯源</span><h3>{layerTrace.record.title}</h3><p>{layerTrace.layer === 'abstraction' ? '第三层抽象 → 第二层材料 → 第一层原始快照' : '第二层材料 → 第一层原始快照'}</p></div><Button appearance="subtle" size="small" icon={<Dismiss20Regular />} aria-label="关闭溯源" onClick={() => setLayerTrace(null)} /></div>
        {layerTrace.extractions.map(material => <details key={material.id} open><summary>第二层材料：{material.title}</summary><p>{material.content}</p>{material.citations?.map((citation, i) => <blockquote key={i}>{citation.quote}</blockquote>)}</details>)}
        {layerTrace.sources.map(snapshot => <details key={snapshot.id}><summary>第一层原始快照：{snapshot.locator}</summary><p className="path">SHA-256 {snapshot.revision}</p><pre>{snapshot.content}</pre></details>)}
      </section>}
    </> : tab === 'search' ? <>
      <form className="knowledge-search" onSubmit={e => { e.preventDefault(); void search(); }}>
        <Field label="检索问题"><Input value={query} onChange={(_, d) => setQuery(d.value)} placeholder="查找结论、原始讨论或相关项目" /></Field>
        <Field label="范围"><Select value={scope} onChange={e => setScope(e.target.value)}><option value="project">当前项目</option><option value="all">全部正式项目</option></Select></Field>
        <Field label="材料层"><Select value={layer} onChange={e => setLayer(e.target.value)}><option value="all">原始材料与知识</option><option value="raw">原始材料</option><option value="knowledge">知识页</option></Select></Field>
        <Field label="引擎"><Select value={engine} onChange={e => setEngine(e.target.value)}><option value="auto">融合检索</option><option value="local">本地词项</option><option value="qmd">QMD</option><option value="ohs">Hybrid Search</option></Select></Field>
        <Button type="submit" appearance="primary" icon={<Search20Regular />} disabled={!!busy || !query.trim()}>检索</Button>
      </form>
      {results && <><p>{results.hits.length} 条结果 · 实际使用：{results.engines.join('、')}</p>{results.warnings.map((w, i) => <p className="form-error" key={i}>{w}</p>)}
        {results.metrics && <p className="subtle">召回 {results.metrics.candidates} 个候选，展开 {results.metrics.bodies_loaded} 份正文，读取 {results.metrics.returned_bytes.toLocaleString()} 字节，缓存命中 {results.metrics.cache_hits} 次。</p>}
        {!results.hits.length && <div className="compact-empty">没有找到匹配材料。可扩大到全部项目，或更新索引后重试。</div>}
        {results.hits.map(hit => <article className="knowledge-hit" key={hit.id}><div><Badge appearance="outline">{hit.project}</Badge> <Badge appearance="outline">{hit.layer === 'raw' ? '原始材料' : '知识页'}</Badge> <span className="subtle">{hit.engines.join(' + ')}</span></div><h3>{hit.title}</h3><p className="path">{hit.path}</p><pre>{hit.content}</pre>{hit.layer === 'knowledge' && <Button size="small" icon={<DocumentSearch20Regular />} disabled={!!busy} onClick={() => void run('evidence', async () => setEvidence(await api<NoteEvidence>('/knowledge/evidence', 'POST', { project_id: hit.project_id, path: hit.path })))}>追溯原始证据</Button>}</article>)}</>}
      {evidence && <section><h3>{evidence.title} · 原始证据</h3><EvidencePanel key={evidence.project_id + evidence.path} note={evidence} /></section>}
      <div className="section-heading"><h3>跨项目关联</h3><Button icon={<Link20Regular />} disabled={!!busy} onClick={() => void run('graph', async () => setGraph(await api<Graph>('/knowledge/graph')))}>读取关联</Button></div>
      {graph && <div className="relation-list">{graph.edges.length ? graph.edges.map((edge, i) => {
        const a = graph.nodes.find(n => n.id === edge.source), b = graph.nodes.find(n => n.id === edge.target);
        return <div className="relation-row" key={i}><span>{a?.project} / {a?.title}</span><Link20Regular /><span>{b?.project} / {b?.title}</span><Badge appearance="outline">{edge.kind === 'wikilink' ? '双链' : '审核关联'}</Badge></div>;
      }) : <p className="subtle">尚无有效关联。关联候选经审核后会显示在这里。</p>}</div>}
    </> : <>
      <section className="provider-settings"><h3>持续加工</h3>
        {pipeline && <><div className="knowledge-toolbar"><Switch label="持续采集原始快照" checked={pipeline.settings.enabled} disabled={!!busy} onChange={(_, d) => void configure({ enabled: d.checked })} /><Switch label="自动准备跨来源任务" checked={pipeline.settings.auto_prepare} disabled={!!busy} onChange={(_, d) => void configure({ auto_prepare: d.checked })} /><Switch label="自动更新索引" checked={pipeline.settings.auto_index} disabled={!!busy} onChange={(_, d) => void configure({ auto_index: d.checked })} /><Switch label="自动执行已准备的模型任务" checked={pipeline.settings.auto_compile} disabled={!!busy || !pipeline.model_enabled} onChange={(_, d) => void configure({ auto_compile: d.checked })} /></div>
          <div className="knowledge-toolbar"><Field label="检查间隔"><Select value={String(pipeline.settings.interval_seconds)} disabled={!!busy} onChange={e => void configure({ interval_seconds: Number(e.target.value) })}><option value="60">1 分钟</option><option value="300">5 分钟</option><option value="900">15 分钟</option><option value="3600">1 小时</option></Select></Field><Button icon={<Play20Regular />} disabled={!!busy} onClick={() => void run('pipeline', async () => { await api(`/projects/${project.id}/pipeline/run`, 'POST', {}); setNotice('本轮持续加工已完成。'); })}>执行一轮</Button></div>
          <p className="subtle">{pipeline.model_enabled ? '后台模型已启用' : '后台模型尚未启用'}{pipeline.last_run?.finished_at ? ` · 最近完成 ${new Date(pipeline.last_run.finished_at).toLocaleString()}` : ''}</p>{pipeline.last_run?.error && <p role="alert" className="form-error">最近一轮失败：{pipeline.last_run.error}</p>}
        </>}
      </section>
      <section className="provider-settings"><h3>检索引擎</h3><p>原始材料由 QMD 检索，知识页由 Hybrid Search 检索。未就绪的引擎会回退到本地词项检索。</p>
        {engines?.projects[project.id]?.qmd?.diagnostics?.semantic_scope === 'source-document-excerpts' && <p className="subtle">QMD 保留全部原始片段全文索引，并对 {engines.projects[project.id].qmd.diagnostics?.semantic_documents?.toLocaleString()} 份文件 / 会话的开头、中部、结尾摘录建立语义索引。命中后可回读完整原文。</p>}
        <div className="provider-row"><div><strong>细块语义索引</strong><p>按章节、函数与消息边界切分。分批续建，每轮最多处理 100 个原始片段。</p><p>{engines?.fine_projects?.[project.id]?.prepared_parts?.toLocaleString() || 0} / {engines?.fine_projects?.[project.id]?.storage_parts?.toLocaleString() || overview?.source_total.toLocaleString() || 0} 个原始片段已切块，生成 {engines?.fine_projects?.[project.id]?.blocks?.toLocaleString() || 0} 个检索块。{engines?.fine_projects?.[project.id]?.status === 'complete' ? '全部细块向量已就绪。' : '细块语义覆盖尚未完成。'}</p></div><Button disabled={!!busy || !engines?.qmd.installed} onClick={() => void run('fine-index', async () => { await api(`/projects/${project.id}/retrieval/chunks`, 'POST', { batch_size: 100, semantic: true }); })}>继续构建细块索引</Button></div>
        {(['qmd', 'ohs'] as const).map(name => {
          const status = engines?.projects[project.id]?.[name];
          return <div className="provider-row" key={name}><div><strong>{name === 'qmd' ? 'QMD' : 'Obsidian Hybrid Search'}</strong><p>{engines?.[name].purpose}</p><Badge appearance="outline" color={status?.status === 'ready' && !status.stale ? 'success' : 'warning'}>{status?.status === 'ready' ? status.stale ? '索引已过期' : `已就绪 · ${status.mode}` : status?.status === 'error' ? '索引失败' : engines?.[name].installed ? '待建立索引' : '尚未安装'}</Badge>{status?.error && <p className="form-error">{status.error}</p>}{status?.diagnostics?.semantic_error && <p className="form-error">语义模型未就绪，全文检索仍可用。{status.diagnostics.semantic_error}</p>}</div><div className="button-row"><Button disabled={!!busy || !engines?.[name].installed} icon={<ArrowClockwise20Regular />} onClick={() => void run(`index-${name}`, async () => { await api(`/projects/${project.id}/retrieval/index`, 'POST', { engine: name }); })}>更新索引</Button>{name === 'qmd' && <Button disabled={!!busy || !engines?.qmd.installed} onClick={() => void run('index-semantic', async () => { await api(`/projects/${project.id}/retrieval/index`, 'POST', { engine: 'qmd', semantic: true }); })}>构建语义索引</Button>}</div></div>;
        })}
      </section>
      <section className="provider-settings"><h3>Claudian 与 Codex</h3><p>使用同一项目来源、知识检索与审核队列。Claudian 中所选 Agent 的 MCP 配置决定连接方式。</p><Button icon={<ArrowDownload20Regular />} disabled={!!busy} onClick={() => void run('integration', async () => setIntegration(await api<Record<string, string>>(`/projects/${project.id}/integration`, 'POST', {})))}>生成项目接入配置</Button>
        {integration && <dl className="integration-files"><dt>Claude / Claudian 配置</dt><dd>{integration.claudian_config}</dd><dt>Codex 配置</dt><dd>{integration.codex_config}</dd><dt>知识加工指引</dt><dd>{integration.workflow}</dd></dl>}
      </section>
    </>}
  </div>;
}
