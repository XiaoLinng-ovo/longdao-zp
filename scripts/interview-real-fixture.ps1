param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$directory = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($directory) | Out-Null
$lines = @(
  @{ role='interviewer'; voice='Microsoft Huihui Desktop'; text='你好，我是今天的面试官。请介绍一下你做过的客服智能助手项目，以及你在项目里负责什么。' },
  @{ role='candidate'; voice='Microsoft Kangkang'; text='嗯，就是客服智能助手那个项目，我负责项目需求分析、开发和上线。我们先整理用户问题，再开发知识检索和工单接口，最后完成灰度发布。' },
  @{ role='interviewer'; voice='Microsoft Huihui Desktop'; text='你刚才说做了知识检索。如果用户的问题没有命中知识库，你会怎么处理？' },
  @{ role='candidate'; voice='Microsoft Kangkang'; text='我们设置了检索置信度门槛。没有命中时不编造答案，而是转人工工单，并记录未解决的问题。我还增加了接口超时重试和日志监控。' }
)
$synth = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
  $synth.Rate = 1
  for ($i=0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]
    $synth.SelectVoice($line.voice)
    $file = Join-Path $directory ('speech-' + $i + '.wav')
    $synth.SetOutputToWaveFile($file)
    $synth.Speak($line.text)
    $synth.SetOutputToNull()
    $line.file = $file
  }
} finally { $synth.Dispose() }
$lines | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $directory 'script.json') -Encoding UTF8
Write-Output 'Generated four controlled Mandarin speech samples with two voices.'
