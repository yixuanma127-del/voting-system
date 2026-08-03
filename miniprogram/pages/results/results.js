const api = require('../../utils/api')

Page({
  data: {
    results: [],
    loading: true,
    maxScore: 1,
    autoRefresh: true,
    _timer: null
  },

  onShow() {
    this.loadResults()
    if (this.data.autoRefresh) {
      this.startTimer()
    }
  },

  onHide() {
    this.stopTimer()
  },

  onUnload() {
    this.stopTimer()
  },

  // 加载结果
  async loadResults() {
    try {
      const results = await api.getResults()

      // 处理图片
      const processed = results.map(r => ({
        ...r,
        image_data: r.image_data
          ? ((r.image_data.startsWith('data:') || r.image_data.startsWith('http')) ? r.image_data : 'data:image/jpeg;base64,' + r.image_data)
          : (r.image_url || '')
      }))

      const maxScore = processed.length > 0
        ? Math.max(...processed.map(r => r.score || 0), 1)
        : 1

      this.setData({ results: processed, maxScore, loading: false })
    } catch (err) {
      console.error('加载结果失败', err)
      this.setData({ loading: false })
    }
  },

  // 切换自动刷新
  toggleAutoRefresh(e) {
    const val = e.detail.value
    this.setData({ autoRefresh: val })
    if (val) {
      this.startTimer()
    } else {
      this.stopTimer()
    }
  },

  startTimer() {
    this.stopTimer()
    this.data._timer = setInterval(() => {
      this.loadResults()
    }, 5000)
  },

  stopTimer() {
    if (this.data._timer) {
      clearInterval(this.data._timer)
      this.data._timer = null
    }
  }
})

