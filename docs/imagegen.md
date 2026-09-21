# Image generation

`imagegen` generates images or edits local reference images through OpenRouter
or Vercel AI Gateway. The coding agent keeps its current model and calls the
image tool when needed

## Setup and use

1. Run `/reload` after this extension is added
2. Use your existing pi login for `openrouter` or `vercel-ai-gateway`. If needed,
   run `/login` and select the provider
3. Run `/image-model`, type to filter, and press Enter to save a model
4. Ask pi to generate an image and give it an output path

Example request:

```text
Create a wide watercolor mountain scene for the home page
Save it to public/images/hero.png
```

For editing, give pi a local reference image and describe the changes. Reference
images are uploaded to the selected provider. The model must support editing

The picker fetches the current image-output models from each configured,
supported provider. It does not list coding models that can only read images.
Access, credits, and organization restrictions still apply at generation time

You can also select an exact model without the picker:

```text
/image-model openrouter/openai/gpt-image-2.5-flare
```

Model IDs come from the provider, not a fixed list. The selected provider, model
ID, and API mode are saved in `<agent_dir>/imagegen.json` for all sessions.
Changing the image model does not change pi's main model. Each tool call reads
the saved choice, so changes in another pi session apply to future calls

## Output and billing

- Tool arguments are `prompt`, `path`, and optional local `references`
- The image API receives only these instructions and images, not the conversation
- Describe style, quality, and dimensions in the prompt. These are instructions,
  not guaranteed API-level size or quality controls
- Requests ask for one image where the API supports a count. If a multimodal
  model returns more, all images are saved with numbered suffixes
- Files retain the original resolution. The extension adjusts the output
  extension to the actual PNG, JPEG, WebP, or GIF format
- Existing files are not overwritten. Use a new output name for each revision
- The first image gets a preview capped at 1024 pixels per side and 1 MB.
  A preview failure does not remove the original files
- Generation has a five-minute deadline and supports cancellation with Esc
- Requests are not retried automatically, to avoid duplicate image charges
- Charges use the selected provider's billing, not the Codex subscription
- Reported `usage.cost` is included in pi's session totals. Raw provider usage
  is kept in the tool result details. Providers that omit cost are not estimated,
  so pi's totals can be lower than the provider bill

## Provider protocols

Pi supplies credentials, headers, and base URLs through its model registry.
The extension does not read or write `auth.json` itself and adds no dependencies

### OpenRouter

- Discovery: `GET /api/v1/images/models`, filtered by image output
- Generation and reference editing: `POST /api/v1/images`
- Reference images use `input_references[].image_url.url`
- Returned image bytes use `data[].b64_json`

[Official OpenRouter image API guide](https://openrouter.ai/docs/guides/overview/multimodal/image-generation)

### Vercel AI Gateway

- Discovery: `GET /v1/models`, filtered by `modalities.output`
- Image-only models: `POST /v1/images/generations` or `/v1/images/edits`
- Edits use `images[].image_url` with base64 data URLs
- Multimodal language models: `POST /v1/chat/completions` with image and text
  output enabled. Images come from `choices[].message.images`

[Official Vercel image API guide](https://vercel.com/docs/ai-gateway/modalities/image-generation/openai)

### Other providers

OpenCode Go and Zen do not currently document an image-output API or expose
image-output capabilities in their model lists, so they are not offered

The extension does not claim universal provider support. Adding a provider
requires its discovery and image-request protocol in
`extensions/lib/image-providers.ts`, not a new hardcoded model list

## Implementation notes

Catalog discovery happens only when `/image-model` runs, with a 30-second
network deadline per provider and no startup network request. A provider failure
is shown while successful catalogs remain available. If none succeeds, the
command fails without changing the saved model

The picker uses pi's `Input` and `SelectList` components, following the selection
pattern in the [pi TUI documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tui.md)

The image catalog stays outside pi's coding-model registry because image-output
models and image endpoints are not interchangeable with coding models. Provider
credentials are resolved again for each request. File writes use pi's shared
file mutation queue
