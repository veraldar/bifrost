import json, math, argparse, os, random, time
import torch
import torch.nn as nn
import torch.nn.functional as F

def set_seed(s):
    random.seed(s); torch.manual_seed(s)

class Block(nn.Module):
    def __init__(self, d, h):
        super().__init__()
        self.ln1, self.ln2 = nn.LayerNorm(d), nn.LayerNorm(d)
        self.attn = nn.MultiheadAttention(d, h, batch_first=True)
        self.mlp = nn.Sequential(nn.Linear(d, 4*d), nn.GELU(), nn.Linear(4*d, d))
    def forward(self, x, attn_mask):
        a, _ = self.attn(self.ln1(x), self.ln1(x), self.ln1(x), attn_mask=attn_mask, need_weights=False)
        x = x + a
        return x + self.mlp(self.ln2(x))

class TinyLM(nn.Module):
    def __init__(self, vocab, d=128, nl=4, h=4, ctx=256):
        super().__init__()
        self.ctx = ctx
        self.emb = nn.Embedding(vocab, d)
        self.pos = nn.Embedding(ctx, d)
        self.blocks = nn.ModuleList([Block(d, h) for _ in range(nl)])
        self.ln = nn.LayerNorm(d)
        self.head = nn.Linear(d, vocab)
    def forward(self, idx):
        B, T = idx.shape
        x = self.emb(idx) + self.pos(torch.arange(T, device=idx.device))
        mask = torch.triu(torch.full((T, T), float("-inf"), device=idx.device), 1)
        for b in self.blocks:
            x = b(x, mask)
        return self.head(self.ln(x))

class Corpus:
    def __init__(self, text, stoi):
        self.text = text
        self.model_stoi = stoi
        self.stoi = stoi
    def batch(self, bs, dev):
        t, ctx = self.text, self.ctx_size
        ix = torch.randint(0, len(t) - ctx - 1, (bs,))
        x = torch.stack([torch.tensor([self.stoi[c] for c in t[i:i+ctx]]) for i in ix])
        y = torch.stack([torch.tensor([self.stoi[c] for c in t[i+1:i+ctx+1]]) for i in ix])
        return x.to(dev), y.to(dev)

def make_stoi(strings):
    stoi = {c: i for i, c in enumerate(sorted(set("".join(strings))))}
    return stoi

@torch.no_grad()
def continuation_logprob(model, stoi, ctx_text, cont_text, dev):
    ids = [stoi[c] for c in ctx_text if c in stoi][-model.ctx:]
    cont = [stoi[c] for c in cont_text if c in stoi]
    if not cont:
        return 0.0
    seq = (ids + cont)[-model.ctx:]
    x = torch.tensor([seq[:-1]], device=dev)
    logits = model(x)[0]
    lp = F.log_softmax(logits, -1)
    tgt = cont[-(len(seq) - 1):]
    lps = lp[torch.arange(len(tgt)), torch.tensor(tgt, device=dev)]
    return lps.mean().item()

@torch.no_grad()
def assoc_eval(model, stoi, data, sessions, dev, max_probes=60):
    hits1, mrr, n = 0, 0.0, 0
    for asso in data["associations"][:max_probes]:
        probe = asso["probe"]
        target = sessions[asso["target"]["id"]]
        decoys = [sessions[d["id"]] for d in asso["decoys"]]
        prime = f"day {probe['day']} topic {probe['topic']}\n{probe['text']}"[-model.ctx//2:]
        scores = []
        for cand, lab in [(target, 1)] + [(d, 0) for d in decoys]:
            cont = f"\nday {cand['day']} topic {cand['topic']}\n{cand['text']}"
            scores.append((continuation_logprob(model, stoi, prime, cont, dev), lab))
        scores.sort(key=lambda x: -x[0])
        r = [i for i, (_, lab) in enumerate(scores) if lab == 1][0] + 1
        if r == 1:
            hits1 += 1
        mrr += 1.0 / r
        n += 1
    return hits1 / n, mrr / n

@torch.no_grad()
def heldout_loss(model, stoi, texts, dev):
    tot, cnt = 0.0, 0
    for t in texts:
        ids = [stoi[c] for c in t if c in stoi][:model.ctx + 1]
        if len(ids) < 64:
            continue
        x = torch.tensor([ids[:-1]], device=dev)
        y = torch.tensor([ids[1:]], device=dev)
        lp = F.cross_entropy(model(x).reshape(-1, len(stoi)), y.reshape(-1), reduction="mean")
        tot += lp.item(); cnt += 1
    return tot / max(1, cnt)

def train(model, corpus, steps, bs, lr, dev, exclude_frozen=None):
    opt = torch.optim.AdamW(
        [p for n, p in model.named_parameters() if not (exclude_frozen and n.startswith(exclude_frozen))],
        lr=lr)
    model.train()
    t0 = time.time()
    for i in range(steps):
        x, y = corpus.batch(bs, dev)
        loss = F.cross_entropy(model(x).reshape(-1, len(corpus.stoi)), y.reshape(-1))
        opt.zero_grad(); loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        if i % 200 == 0:
            print(f"  step {i}/{steps} loss {loss.item():.3f} ({time.time()-t0:.0f}s)", flush=True)
    model.eval()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--p1-steps", type=int, default=2500)
    ap.add_argument("--p2-steps", type=int, default=1200)
    ap.add_argument("--bs", type=int, default=24)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--out", default="results.json")
    a = ap.parse_args()
    set_seed(1000 + a.seed)
    dev = "cpu"
    torch.set_num_threads(os.cpu_count())

    data = json.load(open(f"{a.data}/ledger.json"))
    sessions = {s["id"]: s for s in data["sessions"]}
    old_text = open(f"{a.data}/stream_old.txt", encoding="utf-8").read()
    new_text = open(f"{a.data}/stream_new.txt", encoding="utf-8").read()
    stoi = make_stoi([old_text[:200000], new_text[:200000]])
    model = TinyLM(len(stoi)).to(dev)

    print("== phase 1: base training on old topics ==", flush=True)
    corpus = Corpus(old_text, stoi)
    corpus.ctx_size = model.ctx
    train(model, corpus, a.p1_steps, a.bs, a.lr, dev)
    model.eval()

    ho = {k: [sessions[i]["text"] for i in v] for k, v in data["heldout"].items()}
    base_old = heldout_loss(model, stoi, ho["old"], dev)
    h1, m = assoc_eval(model, stoi, data, sessions, dev)
    print(f"base: old_loss={base_old:.3f} assoc_hit@1={h1:.3f} mrr={m:.3f}", flush=True)
    results = {"base": {"old_loss": base_old, "hit1": h1, "mrr": m}}

    for arm in ["massed", "interleaved", "frozen"]:
        print(f"== phase 2 arm: {arm} ==", flush=True)
        m2 = TinyLM(len(stoi)).to(dev)
        m2.load_state_dict(model.state_dict())
        mix = new_text if arm != "interleaved" else new_text + "\n" + "".join(random.sample(old_text, min(len(old_text), 120000)))
        c2 = Corpus(mix, stoi)
        c2.ctx_size = m2.ctx
        train(m2, c2, a.p2_steps, a.bs, a.lr * 0.5, dev, exclude_frozen=("emb", "pos", "blocks") if arm == "frozen" else None)
        m2.eval()
        ol = heldout_loss(m2, stoi, ho["old"], dev)
        h, mm = assoc_eval(m2, stoi, data, sessions, dev)
        print(f"{arm}: old_loss={ol:.3f} (base {base_old:.3f}) assoc_hit@1={h:.3f} mrr={mm:.3f}", flush=True)
        results[arm] = {"old_loss": ol, "hit1": h, "mrr": mm}
        del m2

    results["chance_hit1"] = 0.1
    json.dump(results, open(a.out, "w"), indent=2)
    print(json.dumps(results, indent=2))

if __name__ == "__main__":
    main()
