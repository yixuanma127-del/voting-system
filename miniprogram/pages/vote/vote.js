const api = require('../../utils/api')
const app = getApp()

Page({
  data: {
    events: [],               // 所有活动
    eventNames: [],           // 给 picker 用的名称数组
    currentEventIndex: 0,
    currentEventId: 0,
    currentEventName: '',
    currentRankLimit: 5,
    eventEnded: false,
    works: [],
    loading: true,
    selectedOrder: [],
    selectedMap: {},
    rankLabels: ['🥇1', '🥈2', '🥉3', '第4名', '第5名'],
    hasVoted: false,
    submitting: false
  },

  onLoad() {
    // 先确保 token 存在；兜底时也写入本地缓存，保证重启后仍是同一标识。
    if (!app.globalData.voterToken) {
      const savedToken = wx.getStorageSync('voter_token')
      const token = savedToken || app.generateUUID()
      if (!savedToken) {
        wx.setStorageSync('voter_token', token)
      }
      app.globalData.voterToken = token
    }
    this.init()
  },

  async init() {
    try {
      const events = await api.getEvents()
      this.setData({ events })

      if (events.length > 0) {
        const names = events.map(e => e.name)
        this.setData({
          eventNames: names,
          currentEventIndex: 0,
          currentEventId: events[0].id,
          currentEventName: events[0].name,
          currentRankLimit: parseInt(events[0].rank_limit, 10) || 5,
          eventEnded: !!events[0].is_ended,
          rankLabels: this.buildRankLabels(parseInt(events[0].rank_limit, 10) || 5)
        })
        await this.loadWorks(events[0].id)
      } else {
        this.setData({
          currentEventName: '暂无活动',
          loading: false
        })
      }
    } catch (err) {
      console.error('加载失败', err)
      this.setData({ loading: false })
    }
  },

  // 切换活动
  async onEventChange(e) {
    const index = parseInt(e.detail.value)
    const event = this.data.events[index]
    if (!event || event.id === this.data.currentEventId) return

    this.setData({
      currentEventIndex: index,
      currentEventId: event.id,
      currentEventName: event.name,
      currentRankLimit: parseInt(event.rank_limit, 10) || 5,
      eventEnded: !!event.is_ended,
      rankLabels: this.buildRankLabels(parseInt(event.rank_limit, 10) || 5),
      loading: true,
      works: [],
      selectedOrder: [],
      selectedMap: {},
      hasVoted: false
    })

    await this.loadWorks(event.id)
  },

  // 加载作品
  async loadWorks(eventId) {
    try {
      // 并行加载作品和投票状态
      const [works, voteCheck] = await Promise.all([
        api.getWorks(eventId),
        api.checkVote(eventId).catch(() => ({ hasVoted: false }))
      ])

      this.setData({
        works,
        loading: false,
        hasVoted: voteCheck && voteCheck.hasVoted
      })
    } catch (err) {
      console.error('加载作品失败', err)
      this.setData({ loading: false })
    }
  },

  buildRankLabels(limit) {
    const medals = ['🥇1', '🥈2', '🥉3']
    return Array.from({ length: limit }, (_, index) => medals[index] || `第${index + 1}名`)
  },

  // 选择作品
  selectWork(e) {
    const { id, title } = e.currentTarget.dataset
    const { selectedOrder, selectedMap } = this.data

    // 如果已选，取消选择
    if (selectedMap[id] !== undefined) {
      const rankIndex = selectedMap[id]
      const newOrder = selectedOrder.filter(item => item.id !== id)
      const newMap = {}

      // 重新映射
      newOrder.forEach((item, idx) => {
        newMap[item.id] = idx
      })

      this.setData({
        selectedOrder: newOrder,
        selectedMap: newMap
      })
      return
    }

    // 已选满活动设置的排名数量，提示替换
    if (selectedOrder.length >= this.data.currentRankLimit) {
      wx.showModal({
        title: '提示',
        content: `已选择 ${this.data.currentRankLimit} 件作品，请先取消一项后再选择`,
        showCancel: false,
        confirmText: '知道了'
      })
      return
    }

    // 添加选择
    const newOrder = [...selectedOrder, { id, title }]
    const newMap = { ...selectedMap, [id]: newOrder.length - 1 }

    this.setData({
      selectedOrder: newOrder,
      selectedMap: newMap
    })
  },

  // 清空选择
  clearSelections() {
    this.setData({
      selectedOrder: [],
      selectedMap: {}
    })
  },

  // 提交投票
  async submitVote() {
    const { selectedOrder, submitting, currentEventId, currentRankLimit, eventEnded } = this.data
    if (selectedOrder.length !== currentRankLimit || submitting || eventEnded) return

    const workIds = selectedOrder.map(item => item.id)

    this.setData({ submitting: true })

    try {
      await api.submitVote(currentEventId, workIds)
      wx.showToast({ title: '投票成功！', icon: 'success' })
      this.setData({ hasVoted: true, submitting: false })
    } catch (err) {
      console.error('投票失败', err)
      this.setData({ submitting: false })
      if (err && err.error && err.error.includes('已经投过票')) {
        this.setData({ hasVoted: true })
        wx.showToast({ title: '您已投过票', icon: 'none' })
      } else {
        wx.showToast({ title: '投票失败，请重试', icon: 'none' })
      }
    }
  }
})



