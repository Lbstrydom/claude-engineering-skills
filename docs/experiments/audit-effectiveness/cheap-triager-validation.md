# Cheap-Triager Validation

- Candidate model: `z-ai/glm-5.2`
- Dataset hash: `7c441b7615b625c69cf41583f7b3af51cd8a255e9f251b9a8c13e333b21692fb`
- Generated: 2026-07-12T13:12:41.400Z
- **Result: PASSED**

| Stratum | Count | False-dismissal rate | 95% CI |
|---|---|---|---|
| contrarian | 789 | 3.3% | [2.3%, 4.8%] |
| random-tail | 100 | 1.0% | [0.2%, 5.5%] |
| known-defect | 48 | 0.0% | [0.0%, 7.4%] |
| high-dismissal | 126 | 0.0% | [0.0%, 3.0%] |
| omission-dismissal | 17 | 0.0% | [0.0%, 18.4%] |

Thresholds: HIGH/omission ≤ 5%, overall ≤ 10%.
