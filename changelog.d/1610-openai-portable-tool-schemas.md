- Fix OpenAI voice and text chat failing with "Could not connect": OpenAI
  rejects the `resolve_area` candidate-id pattern (a Unicode `\p{L}` class), so
  OpenAI now gets a copy of the tool schemas without it. The strict pattern
  still validates the model's calls locally and is sent to Gemini unchanged
  (byrdit).
