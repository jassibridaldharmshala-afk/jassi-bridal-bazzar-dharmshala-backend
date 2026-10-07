const { Thread, Message, Post } = require('./models');

async function overview(req, res) {
  const days = Math.max(7, Math.min(90, Number(req.query.days || 30)));
  const since = new Date(Date.now() - days * 86400000), storeId = req.socialStore._id;
  const [inbound, outbound, unresolved, overdue, published, failed, replies] = await Promise.all([
    Message.countDocuments({ storeId, direction: 'inbound', sentAt: { $gte: since } }),
    Message.countDocuments({ storeId, direction: 'outbound', sentAt: { $gte: since } }),
    Thread.countDocuments({ storeId, resolved: false }),
    Thread.countDocuments({ storeId, resolved: false, lastInboundAt: { $lt: new Date(Date.now() - 3600000) }, $or: [{ snoozedUntil: null }, { snoozedUntil: { $lte: new Date() } }] }),
    Post.countDocuments({ storeId, status: 'published', updatedAt: { $gte: since } }),
    Post.countDocuments({ storeId, status: { $in: ['failed', 'partial', 'review'] }, updatedAt: { $gte: since } }),
    Message.aggregate([{ $match: { storeId, direction: 'outbound', sentAt: { $gte: since } } }, { $lookup: { from: Message.collection.name, let: { thread: '$threadId', sent: '$sentAt' }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$threadId', '$$thread'] }, { $eq: ['$direction', 'inbound'] }, { $lte: ['$sentAt', '$$sent'] }] } } }, { $sort: { sentAt: -1 } }, { $limit: 1 }], as: 'previous' } }, { $unwind: '$previous' }, { $project: { ms: { $subtract: ['$sentAt', '$previous.sentAt'] } } }, { $match: { ms: { $gte: 0, $lte: 86400000 } } }, { $group: { _id: null, average: { $avg: '$ms' } } }]),
  ]);
  res.json({ days, messages: { inbound, outbound }, inbox: { unresolved, overdue, replyRate: inbound ? Math.min(100, Math.round(outbound / inbound * 100)) : 0, averageResponseMinutes: replies[0] ? Math.round(replies[0].average / 60000) : null }, publishing: { published, needsAttention: failed } });
}
module.exports = { overview };
