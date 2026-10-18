# Image generation

`imagegen` uses Pi's native image catalog and `modelRegistry.generateImages()`
The coding agent keeps its current model and calls the image tool when needed

## Setup and use

1. Run `/reload` after this extension is added
2. Configure an image provider through Pi's `/login` or its API-key environment
   variable. Pi 1.3.0 includes OpenRouter image models, using `/login openrouter`
   or `OPENROUTER_API_KEY`
3. Run `/image-model`, type to filter, and press Enter to save a model
4. Ask pi to generate an image and give it an output path

Example request:

```text
Create a wide watercolor mountain scene for the home page
Save it to public/images/hero.png
```

For editing, give pi a local reference image and describe the changes. Reference
images are uploaded to the selected provider. The model must accept image input
and support the requested edit

The picker uses `getAvailableOfType("image")`, not a separate provider request
or a fixed model list. It excludes chat-only and image-reading chat models
Pi owns catalog updates, cached metadata, credentials, and headers
A small registered provider adapter corrects its image-only OpenRouter endpoint
Use `pi update --models` to refresh Pi's catalog. Access, credits, and provider
restrictions still apply at generation time

You can also select an exact catalog model without the picker:

```text
/image-model openrouter/openai/gpt-image-2.5-flare
```

The selection is saved as `model` in `<agent_dir>/image-model.json` for all
sessions. It shares the picker and queued settings writes with subagent,
browser, and commit. Each tool call reads the saved choice and resolves it
against Pi's available image catalog. An unavailable choice fails without
switching models. `/model-settings` shows the saved choice and its availability
Changing the image model does not change Pi's main model

## Native API limits

- `/image-thinking` is removed. Pi 1.3.0's image model and request types have no
  thinking level, and its OpenRouter image implementation sends no reasoning
  control. Image quality is not a thinking level
- Select a model again with `/image-model` to replace saved provider-specific
  metadata and thinking settings with the model reference alone
- The old Vercel HTTP integration is removed. Vercel image models are not in
  Pi 1.3.0's built-in image catalog. They require native image support in a Pi
  provider before this extension can offer them
- Other providers are offered when Pi registers available image models and a
  matching native image implementation
- Pi 1.3.0 sends every OpenRouter image model to Chat Completions. Image-only
  models such as `openai/gpt-image-2.5-flare` reject that endpoint with HTTP 404
  The extension registers an image implementation through Pi's provider API
  It sends image-only models to `POST /api/v1/images`, with `prompt` and optional
  `input_references`, and normalizes `data[].b64_json` into native image blocks
  Models with text output still use Pi's native Chat Completions implementation
  The catalog, credentials, exact selection, and `generateImages()` call stay native
  There is no model substitution or retry through another endpoint

[OpenRouter Image API](https://openrouter.ai/docs/guides/overview/multimodal/image-generation)

## Output and billing

- Tool arguments are `prompt`, `path`, and optional local `references`
- The image API receives only these instructions and images, not the conversation
- Describe style, quality, and dimensions in the prompt. These are instructions,
  not guaranteed API-level size or quality controls
- All returned image blocks are saved, with numbered suffixes for extra images
  The native API exposes no image-count control. The image-only adapter requests one
- Files retain the original bytes and resolution. The extension adjusts the
  output extension to the actual PNG, JPEG, WebP, or GIF format
- Existing files are not overwritten. Writes use Pi's shared file mutation queue
  and exclusive creation. Use a new output name for each revision. If a later
  write fails, files already saved remain on disk
- The first image gets a preview capped at 1024 pixels per side and 1 MB
  A preview failure does not remove the original files
- Generation has a five-minute deadline and supports cancellation with Esc
- Native request retries are disabled with `maxRetries: 0` to avoid duplicate
  image charges
- Charges use the selected provider's billing, not the Codex subscription
- Usage is passed to session totals and tool details, including native error
  results that report usage. The image-only adapter uses OpenRouter's reported
  `usage.cost` when present. Pi's native Chat Completions implementation instead
  estimates cost from reported tokens and catalog prices
  Missing usage or cost and provider-specific charges can make totals incomplete
- Provider text blocks are included with the saved paths. Only the first image's
  reduced preview enters the conversation, not every full-resolution image

See Pi's [image model guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md#use-image-models)
and [image API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/codemode.md#generate-images)
