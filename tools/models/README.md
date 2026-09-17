# tools/models

Export/quantize scripts and prompt-embedding precompute (architecture.md §15.1). Built in Phase 4:
`export_vit_prompts.py` precomputes the zero-shot ViT's text-prompt embeddings at build time so
the text encoder does not ship; `quantize.py` produces int8/fp16 variants of the client models.
