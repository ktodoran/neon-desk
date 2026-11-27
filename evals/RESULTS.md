# Evaluation results

- Date: 2026-11-27
- Embedding model: `qwen3-embedding:0.6b`
- Chat model: `gemma4:12b`
- Knowledge base: 4 documents
- Passages given to the model for each answer: 3

## Retrieval

Questions with a known source document: 22

| Metric | Value |
| --- | --- |
| Recall@1 | 90.9% |
| Recall@3 | 100.0% |
| Recall@5 | 100.0% |
| MRR | 0.955 |

## End to end

| Metric | Value |
| --- | --- |
| Cases passed | 100.0% of 38 |
| Routing accuracy | 100.0% |
| Citation accuracy | 100.0% |

| Category | Passed |
| --- | --- |
| answerable | 20 / 20 |
| unanswerable | 5 / 5 |
| action | 4 / 4 |
| human | 2 / 2 |
| follow_up | 3 / 3 |
| injection | 4 / 4 |
