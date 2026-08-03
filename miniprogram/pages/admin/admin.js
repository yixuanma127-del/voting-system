const api = require('../../utils/api')
const app = getApp()

Page({
  data: {
    activeTab: 'manage',
    // 作品管理
    works: [],
    loading: true,
    voteUrl: '',
    // 添加弹窗
    showAdd: false,
    addForm: { image: '', title: '', author: '', base64: '' },
    addingWork: false,
    // 删除弹窗
    showDelete: false,
    deleteTarget: { id: '', title: '' },
    // 结果
    results: [],
    maxScore: 1,
    // 颁奖
    awardsAnimating: false,
    revealStep: 0,
    allRevealed: false
  },

  onShow() {
    this.setData({ voteUrl: app.globalData.apiBase + '/index.html' })
    this.loadWorks()
    this.loadResults()
    this.setData({ awardsAnimating: false, revealStep: 0 })
  },

  // 切换子标签
  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    this.setData({ activeTab: tab })
    if (tab === 'manage') this.loadWorks()
    if (tab === 'results') this.loadResults()
    if (tab === 'awards') {
      this.loadResults()
      this.setData({ awardsAnimating: false, revealStep: 0 })
    }
  },

  // 加载作品
  async loadWorks() {
    try {
      this.setData({ loading: true })
      const works = await api.getWorks()
      const processed = works.map(w => ({
        ...w,
        image_data: w.image_data
          ? ((w.image_data.startsWith('data:') || w.image_data.startsWith('http')) ? w.image_data : 'data:image/jpeg;base64,' + w.image_data)
          : (w.image_url || '')
      }))
      this.setData({ works: processed, loading: false })
    } catch (err) {
      console.error('加载作品失败', err)
      this.setData({ loading: false })
    }
  },

  // 加载结果
  async loadResults() {
    try {
      const results = await api.getResults()
      const processed = results.map(r => ({
        ...r,
        image_data: r.image_data
          ? ((r.image_data.startsWith('data:') || r.image_data.startsWith('http')) ? r.image_data : 'data:image/jpeg;base64,' + r.image_data)
          : (r.image_url || '')
      }))
      const maxScore = processed.length > 0
        ? Math.max(...processed.map(r => r.score || 0), 1)
        : 1
      this.setData({ results: processed, maxScore })
    } catch (err) {
      console.error('加载结果失败', err)
    }
  },

  // 复制链接
  copyUrl() {
    wx.setClipboardData({
      data: this.data.voteUrl,
      success() {
        wx.showToast({ title: '已复制', icon: 'success' })
      }
    })
  },

  // 显示添加弹窗
  showAddModal() {
    this.setData({
      showAdd: true,
      addForm: { image: '', title: '', author: '', base64: '' }
    })
  },

  // 关闭弹窗
  closeModal() {
    this.setData({ showAdd: false, showDelete: false })
  },

  // 选择图片
  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const tempFilePath = res.tempFiles[0].tempFilePath

        // 读取为 base64
        wx.getFileSystemManager().readFile({
          filePath: tempFilePath,
          encoding: 'base64',
          success: (readRes) => {
            const base64 = readRes.data
            const ext = tempFilePath.split('.').pop().toLowerCase() || 'jpg'
            const mimeMap = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', webp: 'webp' }
            const mime = mimeMap[ext] || 'jpeg'
            const dataUri = `data:image/${mime};base64,${base64}`

            this.setData({
              'addForm.image': dataUri,
              'addForm.base64': base64
            })
          },
          fail: () => {
            wx.showToast({ title: '读取图片失败', icon: 'none' })
          }
        })
      }
    })
  },

  // 输入作品名
  onTitleInput(e) {
    this.setData({ 'addForm.title': e.detail.value })
  },

  // 输入作者
  onAuthorInput(e) {
    this.setData({ 'addForm.author': e.detail.value })
  },

  // 添加作品
  async doAddWork() {
    const { addForm, addingWork } = this.data
    if (!addForm.title || !addForm.base64 || addingWork) return

    this.setData({ addingWork: true })

    try {
      await api.addWork({
        title: addForm.title,
        author: addForm.author,
        image_data: addForm.image
      })

      wx.showToast({ title: '添加成功', icon: 'success' })
      this.setData({ showAdd: false, addingWork: false })
      this.loadWorks()
    } catch (err) {
      console.error('添加失败', err)
      wx.showToast({ title: '添加失败', icon: 'none' })
      this.setData({ addingWork: false })
    }
  },

  // 确认删除
  confirmDelete(e) {
    const { id, title } = e.currentTarget.dataset
    this.setData({
      showDelete: true,
      deleteTarget: { id, title }
    })
  },

  // 执行删除
  async doDelete() {
    const { id } = this.data.deleteTarget
    try {
      await api.deleteWork(id)
      wx.showToast({ title: '已删除', icon: 'success' })
      this.setData({ showDelete: false })
      this.loadWorks()
    } catch (err) {
      console.error('删除失败', err)
      wx.showToast({ title: '删除失败', icon: 'none' })
    }
  },

  // 重置投票
  resetAll() {
    wx.showModal({
      title: '确认重置',
      content: '确定要清空所有投票数据吗？此操作不可撤销。',
      confirmColor: '#c62828',
      success: async (res) => {
        if (res.confirm) {
          try {
            await api.resetVotes()
            wx.showToast({ title: '已重置', icon: 'success' })
            this.loadResults()
          } catch (err) {
            wx.showToast({ title: '重置失败', icon: 'none' })
          }
        }
      }
    })
  },

  // 颁奖典礼
  startAwards() {
    this.setData({
      awardsAnimating: true,
      revealStep: 0,
      allRevealed: false
    })

    // 依次揭晓第3名 → 第2名 → 第1名
    const steps = [
      { step: 1, delay: 800 },
      { step: 2, delay: 2000 },
      { step: 3, delay: 3400 }
    ]

    steps.forEach(({ step, delay }) => {
      setTimeout(() => {
        this.setData({ revealStep: step })
      }, delay)
    })

    setTimeout(() => {
      this.setData({ allRevealed: true })
    }, 5000)
  },

  // 重新播放
  resetAwards() {
    this.setData({
      awardsAnimating: false,
      revealStep: 0,
      allRevealed: false
    })
  }
})

