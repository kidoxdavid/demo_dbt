import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApi } from '../api';

/** A plain page the admin wrote (terms, privacy, returns...). Paragraphs are separated by a blank line; a line starting with ## is a heading. Text is never treated as HTML. */
export function PageView() {
  const { slug = '' } = useParams(); const { data, error } = useApi<{ title: string; body: string }>(`/api/pages/${slug}`);
  useEffect(() => { if (data) document.title = `${data.title} · eazystores`; }, [data]);
  if (error) return <div className="empty"><h2 className="serif">We could not find that page</h2><Link to="/" className="btn" style={{ marginTop: 16 }}>Back to the shop</Link></div>;
  if (!data) return <div className="screen pad"><div className="skeleton" style={{ height: 200 }} /></div>;
  return <div className="screen pad" style={{ paddingTop: 10 }}><div className="co" style={{ maxWidth: 720 }}><h1 className="serif">{data.title}</h1>
    {data.body.split(/\n{2,}/).map((para, i) => para.startsWith('## ') ? <h2 key={i} className="serif" style={{ fontSize: 20, marginTop: 22 }}>{para.slice(3).split('\n')[0]}</h2> : <p key={i} style={{ lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{para}</p>)}</div></div>;
}
/** Links to every published page, at the bottom of the shop. Shows nothing until the admin publishes one. */
export function LegalFooter() {
  const { data } = useApi<{ slug: string; title: string }[]>('/api/pages'); if (!data?.length) return null;
  return <nav aria-label="Information" className="pad" style={{ display: 'flex', gap: 16, flexWrap: 'wrap', padding: '18px 16px 90px', fontSize: 13 }}>{data.map(p => <Link key={p.slug} to={`/pages/${p.slug}`} className="muted" style={{ textDecoration: 'underline' }}>{p.title}</Link>)}</nav>;
}
