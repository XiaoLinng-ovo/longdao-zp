import { Converter } from 'opencc-js/t2cn'

// Only normalize script; never paraphrase, correct recognition, or infer speech.
export const simplifyTranscript = Converter({ from: 't', to: 'cn' })
