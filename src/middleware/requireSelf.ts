import type { RequestHandler } from 'express';
import type { IdParams } from '#schemas/idParamSchema';

// Ownership, which is a different question from `requireRole`. A role check asks "what kind of
// user is this?"; this asks "is this *their* record?" — every musician is allowed to edit a
// musician account, but only their own.
//
// Runs after `authenticate` and after `validateParams`, so req.user is set and :id is a
// well-formed ObjectId by the time it compares them.
const requireSelf: RequestHandler<IdParams> = (req, res, next) => {
  if (req.user?.userId !== req.params.id) {
    next(new Error('You can only modify your own account', { cause: { status: 403 } }));
    return;
  }

  next();
};

export default requireSelf;
