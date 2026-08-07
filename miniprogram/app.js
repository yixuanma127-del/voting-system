App({
  globalData: {
    // 后端 API 地址（部署后替换为你的 HTTPS 域名）
    apiBase: 'https://voting.ewisest.com',
    voterToken: ''
  },

  onLaunch() {
    // 读取或生成投票者标识
    let token = wx.getStorageSync('voter_token')
    if (!token) {
      token = this.generateUUID()
      wx.setStorageSync('voter_token', token)
    }
    this.globalData.voterToken = token
  },

  generateUUID() {
    const s = []
    const hex = '0123456789abcdef'
    for (let i = 0; i < 36; i++) {
      s[i] = hex.substr(Math.floor(Math.random() * 0x10), 1)
    }
    s[14] = '4'
    s[19] = hex.substr((s[19] & 0x3) | 0x8, 1)
    s[8] = s[13] = s[18] = s[23] = '-'
    return s.join('')
  }
})
