import { Converter } from 'opencc-js/t2cn'

// Keep the same script-only conversion as the API, including live checkpoints.
export const simplifyTranscript = Converter({ from: 't', to: 'cn' })
