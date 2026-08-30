import { describe, expect, it } from 'vitest'
import {
  linuxLoopbackListenerInodes,
  windowsCommandLineArguments,
  windowsLoopbackListenerPids,
} from '../src/listener-attestation.js'

describe('M06 listener/process attestation', () => {
  it('selects only the exact Windows IPv4 loopback listener and port', () => {
    const output = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    127.0.0.1:42600       0.0.0.0:0              LISTENING       4100',
      '  TCP    0.0.0.0:42600         0.0.0.0:0              LISTENING       4200',
      '  TCP    127.0.0.1:42601       0.0.0.0:0              LISTENING       4300',
      '  TCP    127.0.0.1:42600       127.0.0.1:54000        ESTABLISHED     4400',
    ].join('\r\n')

    expect([...windowsLoopbackListenerPids(output, 42_600)]).toEqual([4100])
  })

  it('selects only exact Linux loopback LISTEN socket inodes', () => {
    const output = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:A668 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 7001',
      '   1: 00000000:A668 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 7002',
      '   2: 0100007F:A668 0100007F:BEEF 01 00000000:00000000 00:00000000 00000000 1000 0 7003',
      '   3: 00000000000000000000000001000000:A668 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 7004',
    ].join('\n')

    expect([...linuxLoopbackListenerInodes(output, 42_600)]).toEqual(['7001', '7004'])
  })

  it('parses a quoted Windows Node and DSH command without accepting broken quotes', () => {
    expect(
      windowsCommandLineArguments(
        '"C:\\Program Files\\nodejs\\node.exe" "D:\\workspace\\dsh-luban\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" --profile default',
      ),
    ).toEqual([
      'C:\\Program Files\\nodejs\\node.exe',
      'D:\\workspace\\dsh-luban\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
      '--profile',
      'default',
    ])
    expect(windowsCommandLineArguments('"C:\\node.exe D:\\dsh.js --profile default')).toEqual([])
  })
})
