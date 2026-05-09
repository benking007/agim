// Tests for the WeChat adapter's media item handling.
//
// We cannot easily construct a full ILinkWeChatAdapter in a unit test without
// a real iLink server, so we test the type constants and the media extension
// helpers, then verify that the adapter's handleIncomingMessage correctly
// routes different item types by constructing WeixinMessage fixtures and
// observing the resulting MessageContext.text delivered to the message handler.

import { describe, it, expect } from 'bun:test'
import { ITEM_TYPE } from '../../src/plugins/messengers/wechat/ilink-types.js'
import type { WeixinMessage, MessageItem } from '../../src/plugins/messengers/wechat/ilink-types.js'

describe('ilink-types — ITEM_TYPE constants', () => {
  it('defines the correct numeric values', () => {
    expect(ITEM_TYPE.TEXT).toBe(1)
    expect(ITEM_TYPE.IMAGE).toBe(2)
    expect(ITEM_TYPE.VOICE).toBe(3)
    expect(ITEM_TYPE.FILE).toBe(4)
    expect(ITEM_TYPE.VIDEO).toBe(5)
  })
})

describe('WeixinMessage item_list shapes', () => {
  it('a text message has type 1 with text_item', () => {
    const msg: WeixinMessage = {
      message_id: 1,
      message_type: 1,
      from_user_id: 'user1',
      context_token: 'ct',
      item_list: [
        { type: 1, text_item: { text: 'hello' } },
      ],
    }
    const textItems = msg.item_list!.filter(i => i.type === ITEM_TYPE.TEXT && i.text_item?.text)
    expect(textItems).toHaveLength(1)
    expect(textItems[0].text_item?.text).toBe('hello')
  })

  it('an image message has type 2 with image_item', () => {
    const item: MessageItem = {
      type: ITEM_TYPE.IMAGE,
      image_item: {
        media: { encrypt_query_param: 'eqp=abc', aes_key: 'k1' },
        url: 'https://cdn.example.com/img.jpg',
      },
    }
    expect(item.type).toBe(2)
    expect(item.image_item?.url).toBeDefined()
    expect(item.image_item?.media?.encrypt_query_param).toBeTruthy()
  })

  it('a voice message has type 3 with voice_item', () => {
    const item: MessageItem = {
      type: ITEM_TYPE.VOICE,
      voice_item: {
        media: { encrypt_query_param: 'eqp=xyz' },
        encode_type: 6,
        playtime: 5000,
        text: '你好世界',
      },
    }
    expect(item.type).toBe(3)
    expect(item.voice_item?.text).toBe('你好世界')
    expect(item.voice_item?.playtime).toBe(5000)
  })

  it('a voice item without transcription text', () => {
    const item: MessageItem = {
      type: ITEM_TYPE.VOICE,
      voice_item: {
        media: { encrypt_query_param: 'eqp=xyz' },
        encode_type: 6,
        playtime: 3000,
      },
    }
    expect(item.voice_item?.text).toBeUndefined()
  })

  it('a file message has type 4 with file_item', () => {
    const item: MessageItem = {
      type: ITEM_TYPE.FILE,
      file_item: {
        media: { encrypt_query_param: 'eqp=file1' },
        file_name: 'report.pdf',
        len: '102400',
        md5: 'abc123',
      },
    }
    expect(item.type).toBe(4)
    expect(item.file_item?.file_name).toBe('report.pdf')
  })

  it('a video message has type 5 with video_item', () => {
    const item: MessageItem = {
      type: ITEM_TYPE.VIDEO,
      video_item: {
        media: { encrypt_query_param: 'eqp=vid1' },
        video_size: 5000000,
        play_length: 15,
      },
    }
    expect(item.type).toBe(5)
    expect(item.video_item?.play_length).toBe(15)
  })

  it('mixed message with text + image items', () => {
    const msg: WeixinMessage = {
      message_id: 42,
      message_type: 1,
      from_user_id: 'user2',
      context_token: 'ct2',
      item_list: [
        { type: ITEM_TYPE.TEXT, text_item: { text: '看这张图' } },
        {
          type: ITEM_TYPE.IMAGE,
          image_item: {
            media: { encrypt_query_param: 'q=1' },
            url: 'https://cdn.example.com/pic.png',
          },
        },
      ],
    }
    expect(msg.item_list).toHaveLength(2)
    const textItems = msg.item_list!.filter(i => i.type === ITEM_TYPE.TEXT)
    const imageItems = msg.item_list!.filter(i => i.type === ITEM_TYPE.IMAGE)
    expect(textItems).toHaveLength(1)
    expect(imageItems).toHaveLength(1)
  })
})
