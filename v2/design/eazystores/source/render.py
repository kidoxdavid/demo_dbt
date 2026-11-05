import sys; sys.path.insert(0,'.')
from build import *
T=THEMES['A']
def desk_home():
    t=T
    nav=''.join(f'<span style="font-size:14px">{c}</span>' for c in ['Art &amp; prints','Pottery','Perfume','Hair','Toys','3D printed','Jewellery','Candles','Gift guides'])
    cats=''.join(f'<div style="text-align:center"><div style="width:96px;height:96px;border-radius:50%;overflow:hidden;margin:0 auto;box-shadow:0 0 0 1px {t["line"]}">{art(k,TONES[tn])}</div><div style="font-size:14px;margin-top:10px">{n}</div></div>' for k,tn,n in [('print','warm','Art &amp; prints'),('pottery','blush','Pottery'),('perfume','butter','Perfume'),('hair','stone','Hair'),('toy','butter','Toys'),('print3d','sky','3D printed'),('jewel','sage','Jewellery'),('candle','sand','Candles')])
    prods=''.join(f'<div style="width:268px">{card(k,tn,ti,by,pr,ch,was)}</div>' for k,tn,ti,by,pr,ch,was in [('print','warm','Dusk over the hills, A4 print','Harper &amp; Pine','$38','Limited',None),('candle','sand','Cedar &amp; fig soy candle','Ember Lane','$26','Handmade',None),('print3d','sky','Geometric desk planter','Layer Lab','$24',None,None),('perfume','butter','Amber &amp; oud eau de parfum, 50 ml','Maison Nuit','$96',None,'$110')])
    return f'''<div style="width:1280px;background:{t['bg']}">
    <div style="background:{t['ink']};color:#fff;text-align:center;font-size:13px;padding:9px">Free shipping on orders over $75 from Canadian makers</div>
    <div style="display:flex;align-items:center;gap:36px;padding:20px 64px"><span class="logo" style="font-size:28px">eazy<b>stores</b></span><div class="card" style="flex:1;display:flex;gap:12px;align-items:center;padding:13px 20px;border-radius:999px;max-width:560px"><span class="muted">{I['search']}</span><span class="muted" style="font-size:14px">Search for pottery, art, perfume, hair, toys…</span></div><span style="margin-left:auto;display:flex;gap:22px;align-items:center;font-size:14px">Sell on eazystores {I['heart']}{I['user']}{I['bag']}</span></div>
    <div style="display:flex;gap:30px;padding:0 64px 16px;border-bottom:1px solid {t['line']}">{nav}</div>
    <div style="padding:34px 64px 0;display:flex;gap:28px"><div style="flex:1.1;border-radius:28px;background:{t['accsoft']};padding:64px 56px;position:relative;overflow:hidden;height:470px"><span class="chip" style="background:#fff">New season</span><div class="serif" style="font-size:62px;line-height:1.02;margin-top:20px">Made by hand.<br>Chosen with care.</div><div class="muted" style="font-size:18px;margin-top:18px;max-width:400px;line-height:1.5">Distinctive pieces from independent makers across Canada. Shipped straight from their studios.</div><div style="display:flex;gap:12px;margin-top:30px"><div class="btn">Shop new arrivals</div><div class="btn ghost" style="background:#fff">Meet the makers</div></div></div>
    <div style="flex:.9;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1.2fr 1fr;gap:18px;height:470px"><div style="grid-row:span 2;border-radius:24px;overflow:hidden">{art('pottery',TONES['blush'])}</div><div style="border-radius:24px;overflow:hidden">{art('perfume',TONES['butter'])}</div><div style="border-radius:24px;overflow:hidden">{art('candle',TONES['sand'])}</div></div></div>
    <div style="padding:56px 64px 0"><div class="serif" style="font-size:34px">Shop by category</div><div style="display:flex;justify-content:space-between;margin-top:26px">{cats}</div></div>
    <div style="padding:60px 64px 0"><div style="display:flex;justify-content:space-between;align-items:baseline"><div class="serif" style="font-size:34px">New from makers</div><span style="font-size:14px;border-bottom:1px solid {t['ink']}">See all</span></div><div style="display:flex;gap:26px;margin-top:24px">{prods}</div></div>
    <div style="margin:64px 64px 0;border-radius:28px;background:{t['surf']};border:1px solid {t['line']};display:flex;overflow:hidden"><div style="width:420px;position:relative"><div style="position:absolute;inset:0">{art('pottery',TONES['warm'])}</div></div><div style="padding:48px 56px;flex:1"><div class="muted" style="font-size:12px;letter-spacing:.1em;text-transform:uppercase">Maker spotlight</div><div class="serif" style="font-size:42px;margin-top:8px">Clay &amp; Ember</div><div class="muted" style="font-size:17px;line-height:1.55;margin-top:12px;max-width:520px">“I started throwing pots in my garage during winter. Now every mug I make finds a home somewhere in Canada.” Amara, Calgary</div><div class="btn" style="margin-top:22px">Visit the shop</div></div></div>
    <div style="display:flex;gap:40px;padding:56px 64px;justify-content:space-between">{''.join(f'<div style="display:flex;gap:14px;align-items:flex-start;max-width:320px"><span style="color:{t["acc"]}">{I[i]}</span><div><b style="font-size:15px">{h}</b><div class="muted" style="font-size:14px;margin-top:4px;line-height:1.5">{s}</div></div></div>' for i,h,s in [('shield','Buyer protection','If it does not arrive or is not as described, we make it right.'),('store','Real makers','Every shop is run by an independent small business.'),('truck','Shipped with care','Fragile pieces are packed to arrive in one piece.')])}</div></div>'''

OUT='.'
SHEETS={
 '1_home_desktop': sheet('', desk_home(), bg='#E9E5DE').replace('padding:30px 40px 50px','padding:0'),
 '2_buyer_phones': sheet('', ''.join([home('A','Home'),category(),product(),cart()])),
 '3_seller_onboarding': sheet('', ''.join([ob1(),ob2(),ob3(),ob4()])),
 '4_seller_studio': sheet('', studio_desktop()+studio_phone()),
 '5_shop_looks': sheet('', shop('A','Shop look · Atelier',[('pottery','blush','Bud vase','$48'),('pottery','sand','Speckled mug','$34'),('planter','sage','Planter','$42'),('pottery','warm','Serving bowl','$64')])+shop('B','Shop look · Noir',[('pottery','ink','Bud vase','$48'),('pottery','ink','Speckled mug','$34'),('planter','ink','Planter','$42'),('pottery','ink','Serving bowl','$64')])+shop('C','Shop look · Sage',[('pottery','sage','Bud vase','$48'),('pottery','sand','Speckled mug','$34'),('planter','sage','Planter','$42'),('pottery','butter','Serving bowl','$64')])),
 '6_brand_directions': ''.join([]),
}
for name,html in SHEETS.items():
    if name.startswith('6'): continue
    open(f'{name}.html','w').write(html)
for th in 'ABC':
    open(f'dir_{th}.html','w').write(sheet('',home(th,f'Direction {th} · {THEMES[th]["name"]}'),theme=th,bg='#E9E5DE'))
print('html written')

K={'A':[('pottery','blush','Bud vase','$48'),('pottery','sand','Speckled mug','$34'),('planter','sage','Planter','$42'),('pottery','warm','Serving bowl','$64')],
   'B':[('pottery','ink','Bud vase','$48'),('pottery','ink','Speckled mug','$34'),('planter','ink','Planter','$42'),('pottery','ink','Serving bowl','$64')],
   'C':[('pottery','sage','Bud vase','$48'),('pottery','sand','Speckled mug','$34'),('planter','sage','Planter','$42'),('pottery','butter','Serving bowl','$64')]}
for th in 'ABC':
    open(f'shop_{th}.html','w').write(sheet('',shop(th,f'Shop look · {THEMES[th]["name"]}',K[th]),theme=th,bg='#E9E5DE'))
