class InterviewPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.samples = new Float32Array(4096)
    this.length = 0
  }
  process(inputs) {
    const channels = inputs[0]
    if (!channels?.length) return true
    for (let index = 0; index < channels[0].length; index++) {
      let sample = 0
      for (const channel of channels) sample += channel[index] / channels.length
      this.samples[this.length++] = sample
      if (this.length === this.samples.length) {
        this.port.postMessage(this.samples, [this.samples.buffer])
        this.samples = new Float32Array(4096)
        this.length = 0
      }
    }
    return true
  }
}
registerProcessor('interview-pcm', InterviewPcmProcessor)
