from art import art, TONES
THEMES = {
 'A': dict(name='Atelier', bg='#FAF7F2', surf='#FFFFFF', ink='#1F1B16', mut='#6F675C', line='#E9E2D6', acc='#A9532D', accsoft='#F3E4D9', onacc='#FFFFFF', dark=False),
 'B': dict(name='Noir',    bg='#15120F', surf='#1E1A16', ink='#F4EEE6', mut='#A39A8D', line='#2D2822', acc='#C9A66B', accsoft='#2C261D', onacc='#15120F', dark=True),
 'C': dict(name='Sage',    bg='#F3F4ED', surf='#FFFFFF', ink='#1E2A24', mut='#66726A', line='#E1E5DA', acc='#46644F', accsoft='#E3EBDD', onacc='#FFFFFF', dark=False),
}
def css(t):
    return f"""
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Inter:wght@400;500;600&display=swap');
*{{box-sizing:border-box;margin:0;padding:0}} body{{font-family:Inter,system-ui,sans-serif;color:{t['ink']};background:{t['bg']};-webkit-font-smoothing:antialiased}}
.serif{{font-family:Fraunces,Georgia,serif;font-weight:500;letter-spacing:-.01em}} a{{color:inherit;text-decoration:none}}
.logo{{font-family:Fraunces,serif;font-weight:600;font-size:22px;letter-spacing:-.02em}} .logo b{{color:{t['acc']};font-weight:600}}
.btn{{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:{t['acc']};color:{t['onacc']};border-radius:999px;padding:14px 24px;font-weight:600;font-size:15px}}
.btn.ghost{{background:transparent;color:{t['ink']};border:1px solid {t['line']}}} .btn.sm{{padding:10px 18px;font-size:13px}}
.muted{{color:{t['mut']}}} .chip{{display:inline-block;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:{t['acc']};background:{t['accsoft']};padding:5px 10px;border-radius:999px}}
.card{{background:{t['surf']};border:1px solid {t['line']};border-radius:16px}}
.pcard .im{{aspect-ratio:1/1;border-radius:14px;overflow:hidden;position:relative}} .pcard .im svg{{width:100%;height:100%;display:block}}
.pcard .heart{{position:absolute;top:10px;right:10px;width:32px;height:32px;border-radius:50%;background:rgba(255,255,255,.9);display:grid;place-items:center;color:#1F1B16}}
.pcard .tag{{position:absolute;left:10px;bottom:10px}} .pcard h4{{font-size:14px;font-weight:500;margin-top:10px;line-height:1.3}} .pcard .by{{font-size:12px;color:{t['mut']};margin-top:2px}}
.pcard .pr{{font-size:14px;font-weight:600;margin-top:4px}} .pcard .pr s{{font-weight:400;color:{t['mut']};margin-left:6px;font-size:12px}}
.stars{{color:{t['acc']};font-size:12px;letter-spacing:1px}}
.ico{{width:20px;height:20px;stroke:currentColor;fill:none;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}}
.phone{{width:390px;height:844px;border-radius:46px;background:{t['bg']};overflow:hidden;position:relative;box-shadow:0 30px 60px rgba(40,30,20,.22),0 0 0 9px #17130f;display:flex;flex-direction:column}}
.sb{{height:46px;display:flex;align-items:flex-end;justify-content:space-between;padding:0 30px 6px;font-size:14px;font-weight:600;flex:none}}
.scroll{{flex:1;overflow:hidden;position:relative}}
.tabbar{{position:absolute;left:14px;right:14px;bottom:16px;height:64px;border-radius:32px;background:{'rgba(30,26,22,.72)' if t['dark'] else 'rgba(255,255,255,.72)'};backdrop-filter:blur(18px);border:1px solid {'rgba(255,255,255,.08)' if t['dark'] else 'rgba(0,0,0,.06)'};box-shadow:0 10px 30px rgba(0,0,0,.14);display:flex;align-items:center;justify-content:space-around;font-size:10px;color:{t['mut']}}}
.tabbar div{{display:flex;flex-direction:column;align-items:center;gap:3px}} .tabbar .on{{color:{t['ink']};background:{t['accsoft']};padding:8px 14px;border-radius:22px}}
.grid2{{display:grid;grid-template-columns:1fr 1fr;gap:14px}} .pad{{padding:0 18px}}
div>svg[viewBox="0 0 200 200"]{{width:100%;height:100%;display:block}}
.cap{{position:absolute;top:-34px;left:0;right:0;text-align:center;font:600 13px Inter;letter-spacing:.08em;text-transform:uppercase;color:#6b6358}}
"""
I = {
 'search':'<svg class="ico" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
 'heart':'<svg class="ico" viewBox="0 0 24 24"><path d="M12 20s-7-4.4-9-9a5 5 0 0 1 9-3 5 5 0 0 1 9 3c-2 4.6-9 9-9 9z"/></svg>',
 'bag':'<svg class="ico" viewBox="0 0 24 24"><path d="M5 8h14l-1 12H6L5 8z"/><path d="M9 8a3 3 0 0 1 6 0"/></svg>',
 'user':'<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/></svg>',
 'home':'<svg class="ico" viewBox="0 0 24 24"><path d="M4 11l8-7 8 7v9H4z"/></svg>',
 'grid':'<svg class="ico" viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>',
 'cam':'<svg class="ico" viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
 'plus':'<svg class="ico" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
 'check':'<svg class="ico" viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>',
 'chev':'<svg class="ico" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
 'truck':'<svg class="ico" viewBox="0 0 24 24"><path d="M3 6h11v10H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="18" r="1.8"/><circle cx="17" cy="18" r="1.8"/></svg>',
 'shield':'<svg class="ico" viewBox="0 0 24 24"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/></svg>',
 'msg':'<svg class="ico" viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>',
 'box':'<svg class="ico" viewBox="0 0 24 24"><path d="M4 8l8-4 8 4v9l-8 4-8-4z"/><path d="M4 8l8 4 8-4M12 12v9"/></svg>',
 'tag':'<svg class="ico" viewBox="0 0 24 24"><path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.3"/></svg>',
 'chart':'<svg class="ico" viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/></svg>',
 'wallet':'<svg class="ico" viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="3"/><path d="M16 12h5"/></svg>',
 'store':'<svg class="ico" viewBox="0 0 24 24"><path d="M4 9l2-5h12l2 5M4 9h16v11H4zM9 20v-6h6v6"/></svg>',
}
def stars(n=5): return '<span class="stars">'+'★'*n+'</span>'
def card(kind,tone,title,by,price,chip=None,was=None,rating='4.9 (128)'):
    tag = f'<span class="chip tag">{chip}</span>' if chip else ''
    w = f'<s>{was}</s>' if was else ''
    return f'<div class="pcard"><div class="im">{art(kind,TONES[tone])}<span class="heart">{I["heart"]}</span>{tag}</div><h4>{title}</h4><div class="by">{by}</div><div class="pr">{price}{w}</div></div>'
def phone(inner, label='', tab=None, time='9:41'):
    tabs=''
    if tab is not None:
        names=[('home','Shop'),('grid','Browse'),('heart','Saved'),('bag','Basket'),('user','Account')]
        tabs='<div class="tabbar">'+''.join(f'<div class="{"on" if i==tab else ""}">{I[k]}<span>{n}</span></div>' for i,(k,n) in enumerate(names))+'</div>'
    return f'<div style="position:relative;margin-top:44px"><div class="cap">{label}</div><div class="phone"><div class="sb"><span>{time}</span><span>5G ▮▮▮</span></div><div class="scroll">{inner}</div>{tabs}</div></div>'
def sheet(title, body, theme='A', width=None, bg='#E9E5DE'):
    t=THEMES[theme]
    return f'<!doctype html><html><head><meta charset="utf-8"><style>{css(t)} html,body{{background:{bg}}} .sheet{{padding:30px 40px 50px;display:flex;gap:46px;justify-content:center;align-items:flex-start;{"width:%dpx;"%width if width else ""}}}</style></head><body><div class="sheet">{body}</div></body></html>'
