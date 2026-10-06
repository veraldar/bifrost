"""Import a Freerouting .ses into a .kicad_pcb (headless; pcbnew.ImportSpecctraSES is broken under SWIG/py3.14)."""
import re, sys, pcbnew
def parse(s):
    toks=re.findall(r'\(|\)|"[^"]*"|[^\s()]+',s); st=[[]]
    for t in toks:
        if t=='(': st.append([])
        elif t==')': x=st.pop(); st[-1].append(x)
        else: st[-1].append(t.strip('"'))
    return st[0][0]
def find(n,k): return [c for c in n if isinstance(c,list) and c and c[0]==k]
pcb,ses=sys.argv[1],sys.argv[2]
b=pcbnew.LoadBoard(pcb); root=parse(open(ses).read())
routes=find(root,'routes')[0]; res=find(routes,'resolution')[0]
nm=(1000 if res[1]=='um' else 1e6 if res[1]=='mm' else 25.4)/float(res[2])
P=lambda x,y: pcbnew.VECTOR2I(int(float(x)*nm), int(-float(y)*nm))
layer={b.GetLayerName(l):l for l in range(pcbnew.PCB_LAYER_ID_COUNT)}
padstk={}
for ps in find(find(routes,'library_out')[0],'padstack') if find(routes,'library_out') else []:
    d=float(find(ps,'shape')[0][1][2])*nm; padstk[ps[1]]=d
nw=0;nv=0
for net in find(find(routes,'network_out')[0],'net'):
    ni=b.FindNet(net[1])
    for w in find(net,'wire'):
        p=find(w,'path')[0]; L=layer[p[1]]; wd=int(float(p[2])*nm); c=p[3:]
        pts=[P(c[i],c[i+1]) for i in range(0,len(c),2)]
        for a,z in zip(pts,pts[1:]):
            t=pcbnew.PCB_TRACK(b);t.SetStart(a);t.SetEnd(z);t.SetWidth(wd);t.SetLayer(L);t.SetNet(ni);b.Add(t);nw+=1
    for v in find(net,'via'):
        o=pcbnew.PCB_VIA(b);o.SetPosition(P(v[2],v[3]));d=padstk.get(v[1],6000*nm)
        o.SetWidth(int(d));o.SetDrill(int(d/2));o.SetNet(ni);b.Add(o);nv+=1
pcbnew.SaveBoard(pcb,b); print(f"imported {nw} segments, {nv} vias")
