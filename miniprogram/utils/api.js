const app = getApp()

/**
 * 封装 wx.request，统一处理 base URL 和错误
 */
function request(url, options = {}) {
  const { method = 'GET', data = {}, needAuth = false } = options

  return new Promise((resolve, reject) => {
    wx.request({
      url: app.globalData.apiBase + url,
      method,
      data,
      header: {
        'Content-Type': 'application/json'
      },
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data)
        } else {
          reject(res.data)
        }
      },
      fail(err) {
        wx.showToast({ title: '网络错误', icon: 'none' })
        reject(err)
      }
    })
  })
}

/**
 * 获取所有活动
 */
function getEvents() {
  return request('/api/events')
}

/**
 * 获取默认活动
 */
function getDefaultEvent() {
  return request('/api/events/default')
}

/**
 * 获取作品（按活动）
 * @param {number} eventId
 */
function getWorks(eventId) {
  const url = eventId ? `/api/works?event_id=${eventId}` : '/api/works'
  return request(url)
}

/**
 * 添加作品
 * @param {object} data - { event_id, title, author, image_data }
 */
function addWork(data) {
  return request('/api/works', { method: 'POST', data })
}

/**
 * 删除作品
 * @param {number} id
 */
function deleteWork(id) {
  return request(`/api/works/${id}`, { method: 'DELETE' })
}

/**
 * 获取投票结果（按活动）
 * @param {number} eventId
 */
function getResults(eventId) {
  const url = eventId ? `/api/results?event_id=${eventId}` : '/api/results'
  return request(url)
}

/**
 * 提交投票
 * @param {number} eventId
 * @param {number[]} workIds - 按排名顺序的作品 ID（第1名排第一位）
 */
function submitVote(eventId, workIds) {
  return request('/api/vote', {
    method: 'POST',
    data: {
      event_id: eventId,
      voter_token: app.globalData.voterToken,
      work_ids: workIds
    }
  })
}

/**
 * 检查是否已投票（按活动）
 * @param {number} eventId
 */
function checkVote(eventId) {
  const url = `/api/vote-check?token=${app.globalData.voterToken}&event_id=${eventId}`
  return request(url)
}

/**
 * 重置活动投票
 * @param {number} eventId
 */
function resetVotes(eventId) {
  return request('/api/reset', {
    method: 'POST',
    data: { event_id: eventId }
  })
}

module.exports = {
  getEvents,
  getDefaultEvent,
  getWorks,
  addWork,
  deleteWork,
  getResults,
  submitVote,
  checkVote,
  resetVotes
}
