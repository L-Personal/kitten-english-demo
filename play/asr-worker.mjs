import {env, pipeline, Tensor} from './assets/runtime/transformers.min.js';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = new URL('./assets/models/', import.meta.url).href;
env.backends.onnx.wasm.wasmPaths = new URL('./assets/runtime/', import.meta.url).href;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;
let model;

// Transformers.js 3.8 defaults to English when the language is omitted.
// Whisper's first token predicts the language. Pick between the two supported
// languages before decoding, reusing the same encoder result for both steps.
async function transcribe(audio) {
  const {model: whisper, processor, tokenizer} = model;
  const {input_features} = await processor(audio);
  const init = whisper._prepare_generation_config(null, {});
  const {encoder_outputs} = await whisper._prepare_encoder_decoder_kwargs_for_generation({
    inputs_tensor: input_features,
    model_inputs: {input_features},
    model_input_name: 'input_features',
    generation_config: init,
  });
  const decoder_input_ids = new Tensor('int64', BigInt64Array.of(BigInt(init.decoder_start_token_id)), [1,1]);
  try {
    const scores = await whisper({encoder_outputs,decoder_input_ids});
    const {data} = scores.logits;
    const language = data[init.lang_to_id['<|zh|>']] > data[init.lang_to_id['<|en|>']] ? 'zh' : 'en';
    for (const item of Object.values(scores)) if (item instanceof Tensor) item.dispose();
    const tokens = await whisper.generate({input_features,encoder_outputs,language,task:'transcribe',
      max_new_tokens:50,return_timestamps:false,return_dict_in_generate:false});
    try { return tokenizer.batch_decode(tokens,{skip_special_tokens:true})[0]?.trim() || ''; }
    finally { tokens.dispose(); }
  } finally {
    decoder_input_ids.dispose();
    encoder_outputs.dispose();
    input_features.dispose();
  }
}
self.onmessage = async ({data}) => {
  const {id, audio} = data;
  try {
    if (!audio) {
      model = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', {
        device:'wasm', dtype:'q8',
        progress_callback: event => {
          if (event.status === 'progress') self.postMessage({id, progress:{file:event.file,loaded:event.loaded,total:event.total}});
        },
      });
      self.postMessage({id, ready:true});
    } else {
      const text = await transcribe(audio);
      self.postMessage({id, text});
    }
  } catch (err) { self.postMessage({id,error:String(err.message || err)}); }
};
