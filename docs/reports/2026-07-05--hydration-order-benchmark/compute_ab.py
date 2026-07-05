#!/usr/bin/env python3
import json

candidates = json.load(open('/tmp/claude-mem-bench-20260705/candidates.json'))
judgments = json.load(open('/tmp/claude-mem-bench-20260705/judgments.json'))

def reciprocal_rank(ids, relevant, cutoff):
    for i, cid in enumerate(ids[:cutoff]):
        if cid in relevant:
            return 1.0 / (i + 1)
    return 0.0

def recall_at(ids, relevant, cutoff):
    if not relevant:
        return None
    found = len([cid for cid in ids[:cutoff] if cid in relevant])
    return found / len(relevant)

K = 10
rows = []
for q, relevant_ids in judgments.items():
    relevant = set(relevant_ids)
    cand = candidates[q]
    chroma_order = cand['chroma_order']
    date_desc_order = cand['date_desc_order']

    row = {
        'query': q,
        'n_candidates': cand['candidate_count'],
        'n_relevant': len(relevant),
        'chroma_mrr10': reciprocal_rank(chroma_order, relevant, K),
        'date_desc_mrr10': reciprocal_rank(date_desc_order, relevant, K),
        'chroma_recall10': recall_at(chroma_order, relevant, K),
        'date_desc_recall10': recall_at(date_desc_order, relevant, K),
        'top1_chroma': chroma_order[0] if chroma_order else None,
        'top1_date_desc': date_desc_order[0] if date_desc_order else None,
    }
    row['top1_differs'] = row['top1_chroma'] != row['top1_date_desc']
    rows.append(row)

n = len(rows)
avg_chroma_mrr = sum(r['chroma_mrr10'] for r in rows) / n
avg_date_mrr = sum(r['date_desc_mrr10'] for r in rows) / n
avg_chroma_recall = sum(r['chroma_recall10'] for r in rows) / n
avg_date_recall = sum(r['date_desc_recall10'] for r in rows) / n
top1_diff_count = sum(1 for r in rows if r['top1_differs'])

improved_mrr = sum(1 for r in rows if r['chroma_mrr10'] > r['date_desc_mrr10'])
regressed_mrr = sum(1 for r in rows if r['chroma_mrr10'] < r['date_desc_mrr10'])
tied_mrr = n - improved_mrr - regressed_mrr

improved_recall = sum(1 for r in rows if r['chroma_recall10'] > r['date_desc_recall10'])
regressed_recall = sum(1 for r in rows if r['chroma_recall10'] < r['date_desc_recall10'])
tied_recall = n - improved_recall - regressed_recall

print(f"N queries: {n}")
print(f"Avg MRR@10   chroma(fix)={avg_chroma_mrr:.4f}  date_desc(baseline)={avg_date_mrr:.4f}  delta={avg_chroma_mrr-avg_date_mrr:+.4f}")
print(f"Avg Recall@10 chroma(fix)={avg_chroma_recall:.4f}  date_desc(baseline)={avg_date_recall:.4f}  delta={avg_chroma_recall-avg_date_recall:+.4f}")
print(f"MRR:    improved={improved_mrr}  regressed={regressed_mrr}  tied={tied_mrr}")
print(f"Recall: improved={improved_recall}  regressed={regressed_recall}  tied={tied_recall}")
print(f"Top-1 result differs between orderings: {top1_diff_count}/{n} queries ({100*top1_diff_count/n:.0f}%)")

json.dump(rows, open('/tmp/claude-mem-bench-20260705/ab_results.json', 'w'), indent=2)

print("\n--- per-query detail ---")
for r in sorted(rows, key=lambda r: r['chroma_mrr10'] - r['date_desc_mrr10']):
    print(f"{r['query'][:45]:45s} mrr: date={r['date_desc_mrr10']:.2f} chroma={r['chroma_mrr10']:.2f} | recall: date={r['date_desc_recall10']:.2f} chroma={r['chroma_recall10']:.2f} | top1_diff={r['top1_differs']}")
