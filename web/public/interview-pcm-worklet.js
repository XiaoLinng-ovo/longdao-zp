class InterviewPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.samples = new Float32Array(4096)
    this.length = 0
    this.active = false
    this.port.onmessage = ({ data }) => {
      if (data.type === 'resume') this.active = true
      if (data.type === 'pause') {
        this.active = false
        this.flush()
        this.port.postMessage({ type: 'boundary', id: data.id })
      }
    }
  }
  flush() {
    if (!this.length) return
    const samples = this.samples.slice(0, this.length)
    this.port.postMessage({ type: 'pcm', samples }, [samples.buffer])
    this.length = 0
  }
  process(inputs) {
    if (!this.active) return true
    const channels = inputs[0]
    if (!channels?.length) return true
    for (let index = 0; index < channels[0].length; index++) {
      let sample = 0
      for (const channel of channels) sample += channel[index] / channels.length
      this.samples[this.length++] = sample
      if (this.length === this.samples.length) {
        this.flush()
      }
    }
    return true
  }
}
registerProcessor('interview-pcm', InterviewPcmProcessor)
