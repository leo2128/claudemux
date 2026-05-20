import { describe, expect, test } from 'bun:test'
import { applyMentions, extractPostText, parseInbound } from '../src/content'
import type { InboundMessage } from '../src/content'
import type { Mention } from '../src/types'

function message(type: string, content: unknown, mentions?: Mention[]): InboundMessage {
  return { message_type: type, content: JSON.stringify(content), mentions }
}

describe('parseInbound — text', () => {
  test('extracts plain text', () => {
    expect(parseInbound(message('text', { text: 'hello there' }))).toEqual({ text: 'hello there' })
  })

  test('resolves @-mention placeholders to display names', () => {
    const msg = message('text', { text: '@_user_1 ping' }, [{ key: '@_user_1', name: 'Alice' }])
    expect(parseInbound(msg).text).toBe('@Alice ping')
  })

  test('text with no JSON content falls back gracefully', () => {
    expect(parseInbound({ message_type: 'text', content: 'raw garbage' }).text).toBe('raw garbage')
  })

  test('a message with no content yields the unparseable marker', () => {
    expect(parseInbound({ message_type: 'text' }).text).toBe('(unparseable message)')
  })
})

describe('parseInbound — attachments', () => {
  test('image messages carry the image_key', () => {
    expect(parseInbound(message('image', { image_key: 'img_v2_abc' }))).toEqual({
      text: '(image)',
      imageKey: 'img_v2_abc',
    })
  })

  test('file messages carry the sender-supplied file name', () => {
    expect(parseInbound(message('file', { file_name: 'report.pdf', file_key: 'k' }))).toEqual({
      text: '(file: report.pdf)',
      fileName: 'report.pdf',
    })
  })

  test('an unknown message type is summarized', () => {
    expect(parseInbound(message('audio', { duration: 3 })).text).toBe('(audio message)')
  })
})

describe('extractPostText', () => {
  test('flattens a zh_cn post with title and tagged elements', () => {
    const post = {
      zh_cn: {
        title: 'Title',
        content: [
          [
            { tag: 'text', text: 'hello ' },
            { tag: 'a', text: 'link', href: 'http://x' },
          ],
          [
            { tag: 'at', user_name: 'Bob' },
            { tag: 'text', text: ' look' },
            { tag: 'img', image_key: 'k' },
          ],
        ],
      },
    }
    expect(extractPostText(post)).toBe('Title\nhello link\n@Bob look(image)')
  })

  test('falls back to en_us when zh_cn is absent', () => {
    const post = { en_us: { title: 'Hi', content: [[{ tag: 'text', text: 'world' }]] } }
    expect(extractPostText(post)).toBe('Hi\nworld')
  })

  test('a link with no text renders its href', () => {
    const post = { zh_cn: { content: [[{ tag: 'a', href: 'http://only-href' }]] } }
    expect(extractPostText(post)).toBe('http://only-href')
  })

  test('parseInbound routes post messages through extractPostText', () => {
    const post = { zh_cn: { title: 'T', content: [[{ tag: 'text', text: 'body' }]] } }
    expect(parseInbound(message('post', post)).text).toBe('T\nbody')
  })
})

describe('applyMentions', () => {
  test('returns the text unchanged when there are no mentions', () => {
    expect(applyMentions('plain', undefined)).toBe('plain')
  })

  test('replaces every occurrence of a placeholder', () => {
    const mentions: Mention[] = [{ key: '@_user_1', name: 'Sam' }]
    expect(applyMentions('@_user_1 and @_user_1', mentions)).toBe('@Sam and @Sam')
  })

  test('ignores a mention with no name', () => {
    const mentions: Mention[] = [{ key: '@_user_1' }]
    expect(applyMentions('@_user_1 here', mentions)).toBe('@_user_1 here')
  })
})
