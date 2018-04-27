// Flush all pending transitions to state channel. Types:
/*
Payment lifecycles:
outward payments: add > (we just added) > added (it is in canonical state) > settled or failed
inward payments: added > (we received it with transitions) > settle/fail (pending) > settled/failed

add - add outward hashlock
settle - unlock inward hashlock by providing secret
fail - delete inward hashlock for some reason.

This module has 3 types of behavior:
regular flush: flushes ack with or without transitions
opportunistic flush: flushes only if there are any transitions (used after receiving empty ack response)
during merge: no transitions can be applied, otherwise deadlock could happen
*/

module.exports = async (ch, opportunistic = false) => {
  //await sleep(2000)

  var ch = await me.getChannel(ch.d.partnerId)

  // First, we add a transition to the queue

  if (ch.d.status == 'sent') {
    if (ch.d.flushed_at < new Date() - 10000) {
      l(`Can't flush, awaiting ack. Repeating our request`)
      //me.send(ch.d.partnerId, 'update', ch.d.pending)
    }
    return false
  }

  var newState = await ch.d.getState()
  var ackSig = ec(r(newState), me.id.secretKey)
  var debugState = r(r(newState))

  // array of actions to apply to canonical state
  var transitions = []

  // merge cannot add new transitions because expects another ack
  // in merge mode all you do is ack last (merged) state
  if (ch.d.status == 'master') {
    var inwards = newState[ch.left ? 2 : 3]
    var outwards = newState[ch.left ? 3 : 2]
    var payable = ch.payable

    var pendings = await ch.d.getPayments({
      where: {
        status: {[Sequelize.Op.or]: ['add', 'settle', 'fail']}
      }
    })

    for (var t of pendings) {
      if (t.status == 'settle' || t.status == 'fail') {
        if (me.handicap_dontreveal) {
          l('HANDICAP ON: not revealing our secret to inward')
          continue
        }

        // the beginning is same for both transitions
        var index = inwards.findIndex((hl) => hl[1].equals(t.hash))
        var hl = inwards[index]

        if (!hl) {
          l('No such hashlock')
          continue
        }

        inwards.splice(index, 1)

        if (t.status == 'settle') {
          newState[1][3] += ch.left ? t.amount : -t.amount
          payable += t.amount
          var args = t.secret
        } else {
          var args = t.hash
        }
      } else if (t.status == 'add') {
        // todo: this might be not needed as previous checks are sufficient
        if (
          t.amount < K.min_amount ||
          t.amount > payable ||
          t.destination.equals(me.pubkey) ||
          outwards.length >= K.max_hashlocks
        ) {
          l('error cannot transit this amount. Failing inward.')
          var inward = await t.getInward()

          if (inward) {
            inward.status = 'fail'
            await inward.save()
            var notify = await me.getChannel(inward.deltum.partnerId)
            await notify.d.requestFlush()
          }
          t.status = 'fail_sent'
          await t.save()

          continue
        }
        if (outwards.length >= K.max_hashlocks) {
          l('Cannot set so many hashlocks now, maybe later')
          //continue
        }
        // decrease payable and add the hashlock to state
        payable -= t.amount
        outwards.push(t.toLock())

        var args = [t.amount, t.hash, t.exp, t.destination, t.unlocker]
      }
      // increment nonce after each transition
      newState[1][2]++

      transitions.push([
        methodMap(t.status),
        args,
        ec(r(newState), me.id.secretKey)
      ])

      t.status += '_sent'
      await t.save()
    }

    if (opportunistic && transitions.length == 0) {
      return l('Nothing to flush')
    }
  }

  // transitions: method, args, sig, new state
  var envelope = me.envelope(
    methodMap('update'),
    ackSig,
    transitions,
    debugState, // our current state
    r(ch.d.signed_state) // our last signed state
  )

  ch.d.nonce = newState[1][2]
  ch.d.offdelta = newState[1][3]

  if (transitions.length > 0) {
    ch.d.flushed_at = new Date()
    ch.d.pending = envelope
    ch.d.status = 'sent'
  }

  await ch.d.save()

  if (!me.send(ch.d.partnerId, 'update', envelope)) {
    //l(`${partner} not online, deliver later?`)
  }
}