import { useState } from 'react';
import { Badge, Button, Spinner } from './ui';
import { DocumentSearch20Regular, Link20Regular } from './icons';
import { api } from './api';
import { errorText } from './utils';

type Snapshot = { id: string; locator: string; content: string; revision: string; active: boolean; transcript?: string };
type Evidence = { sources: Snapshot[]; relations: { target_project_id: string; target_path: string }[]; layers?: { record: { id: string; title: string }; extractions: { id: string; title: string; content: string; citations: { source_id: string; quote: string }[] }[] }[] };
export type NoteEvidence = { project_id: string; path: string; title?: string; evidence?: Evidence[]; related?: NoteEvidence[]; untracked?: boolean; missing?: boolean; modified_after_review?: boolean };

export function EvidencePanel({ proposalId, note }: { proposalId?: string; note?: NoteEvidence }) {
  const [entries, setEntries] = useState<Evidence[] | null>(null);
  const [source, setSource] = useState<Snapshot | null>(null);
  const [related, setRelated] = useState<NoteEvidence | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = async () => {
    setBusy(true); setError('');
    try { setEntries([await api<Evidence>(`/proposals/${proposalId}/evidence`)]); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };
  const values = note?.evidence || entries;
  return <section className="evidence-panel" aria-label="原始证据">
    {proposalId && !entries && <Button icon={<DocumentSearch20Regular />} disabled={busy} onClick={() => void load()}>读取原始证据</Button>}
    {busy && <Spinner size="tiny" label="读取证据…" />}
    {error && <p role="alert" className="form-error">{error}</p>}
    {note?.missing && <p role="alert">关联笔记已不存在。</p>}
    {note?.untracked && <p className="subtle">此笔记尚无登记的原始证据。</p>}
    {note?.modified_after_review && <p role="status">笔记在审核后有修改，以下证据对应已审核版本。</p>}
    {values && !values.length && <p className="subtle">没有来源快照。</p>}
    {values?.map((entry, i) => <div key={i}>
      {entry.layers?.map(layer => <details key={layer.record.id}><summary>抽象依据：{layer.record.title}</summary>{layer.extractions.map(material => <div key={material.id}><h4>第二层材料：{material.title}</h4><p>{material.content}</p>{material.citations.map((citation, index) => <blockquote key={index}>{citation.quote}</blockquote>)}</div>)}</details>)}
      {entry.sources.map(s => <div className="build-row" key={s.id}><Button size="small" icon={<DocumentSearch20Regular />} onClick={() => setSource(s)}>{s.locator}</Button><Badge appearance="outline" color={s.active ? 'success' : 'warning'}>{s.active ? '当前版本' : '历史版本'}</Badge></div>)}
      {entry.relations.map(r => <div className="build-row" key={r.target_project_id + r.target_path}><Button size="small" icon={<Link20Regular />} disabled={busy} onClick={() => {
        setBusy(true); setError('');
        void api<NoteEvidence>('/knowledge/evidence', 'POST', { project_id: r.target_project_id, path: r.target_path })
          .then(setRelated).catch(e => setError(errorText(e))).finally(() => setBusy(false));
      }}>{r.target_path}</Button></div>)}
    </div>)}
    {source && <div className="evidence-snapshot"><h4>{source.locator}</h4><p className="path">SHA-256 {source.revision}</p>{source.transcript && <p className="path">{source.transcript}</p>}<pre>{source.content}</pre></div>}
    {related && <div className="related-evidence"><h4>{related.title || related.path}</h4><EvidencePanel key={related.project_id + related.path} note={related} /></div>}
  </section>;
}
