// Block processing code. Verifies precommits sigs then executes tx in it one by one
module.exports = async (precommits, header, ordered_tx_body) => {
  if (header.length < 64 || header.length > 200) {
    return l('Invalid header length: ', precommits, header, ordered_tx_body)
  }

  if (ordered_tx_body.length > K.blocksize) {
    return l('Too long block')
  }

  var all = []

  let [methodId, built_by, prev_hash, timestamp, tx_root, db_hash] = r(header)

  timestamp = readInt(timestamp)
  prev_hash = toHex(prev_hash)

  if (K.prev_hash != prev_hash) {
    l(`Must be based on ${K.prev_hash} but is using ${prev_hash}`)
    return false
  }

  if (readInt(methodId) != methodMap('propose')) {
    return l('Wrong method for block')
  }

  if (timestamp < K.ts) {
    return l('New block from the past')
  }

  if (!sha3(ordered_tx_body).equals(tx_root)) {
    return l('Invalid tx_root')
  }

  if (!db_hash.equals(current_db_hash())) {
    l('DANGER: state mismatch. Some tx was not deterministic')
  }

  if (precommits.length == 0) {
    // this is just dry run
    return true
  } else if (precommits.length != Members.length) {
    return l('Not valid number of precommits')
  }

  // List of events/metadata about current block, used on Explorer page
  let meta = {
    inputs_volume: 0,
    outputs_volume: 0,
    parsed_tx: [],
    cron: [],
    missed_validators: []
  }

  let shares = 0
  let precommit_body = r([methodMap('precommit'), header])
  for (let i = 0; i < Members.length; i++) {
    if (
      precommits[i].length == 64 &&
      ec.verify(precommit_body, precommits[i], Members[i].block_pubkey)
    ) {
      shares += Members[i].shares
    } else {
      meta.missed_validators.push(Members[i].id)
    }
  }

  if (shares < K.majority) {
    return l(`Not enough precommits`)
  }

  // >>> Given block is considered valid and final after this point <<<

  // In case we are member && locked on this prev_hash, unlock to ensure liveness
  // Tendermint uses 2/3+ prevotes as "proof of lock change", but we don't see need in that
  if (me.proposed_block.locked) {
    var locked_prev_hash = r(me.proposed_block.header)[2]

    if (prev_hash == toHex(locked_prev_hash)) {
      //l('Just unlocked from previous proposed block')
      me.proposed_block = {}
    }
  }

  let ordered_tx = r(ordered_tx_body)

  // Processing transactions one by one
  // Long term TODO: parallel execution with pessimistic locks
  for (let i = 0; i < ordered_tx.length; i++) {
    await me.processTx(ordered_tx[i], meta)
  }

  K.ts = timestamp
  K.prev_hash = toHex(sha3(header))

  K.total_blocks++

  if (K.total_blocks % 100 == 0 || ordered_tx.length > 0)
    l(
      `${base_port}: Processed block ${K.total_blocks} by ${readInt(
        built_by
      )}. Signed shares: ${shares}, tx: ${ordered_tx.length}`
    )

  // todo: define what is considered a "usable" block
  if (ordered_tx_body.length < K.blocksize - 1000) {
    K.usable_blocks++
  }

  K.total_tx += ordered_tx.length
  K.total_bytes += ordered_tx_body.length
  K.bytes_since_last_snapshot += ordered_tx_body.length

  // Every x blocks create new installer
  if (K.bytes_since_last_snapshot > K.snapshot_after_bytes) {
    K.bytes_since_last_snapshot = 0

    meta.cron.push(['snapshot', K.total_blocks])
    var old_height = K.last_snapshot_height
    K.last_snapshot_height = K.total_blocks
  }

  // Auto resolving disputes that are due
  all.push(
    Insurance.findAll({
      where: {dispute_delayed: K.usable_blocks},
      include: {all: true}
    }).then(async (insurances) => {
      for (let ins of insurances) {
        meta.cron.push(['autodispute', ins, await ins.resolve()])
      }
    })
  )

  // Executing onchaing gov proposals that are due
  let jobs = await Proposal.findAll({
    where: {delayed: K.usable_blocks},
    include: {all: true}
  })

  for (let job of jobs) {
    var approved = 0
    for (let v of job.voters) {
      var voter = K.members.find((m) => m.id == v.id)
      if (v.vote.approval && voter) {
        approved += voter.shares
      } else {
        // TODO: denied? slash some votes?
      }
    }

    if (approved >= K.majority) {
      await job.execute()
      meta.cron.push(['executed', job.desc, job.code, job.patch])
    }

    await job.destroy()
  }

  // only members do snapshots, as they require extra computations
  if (me.my_member && K.bytes_since_last_snapshot == 0) {
    // it's important to flush current K to disk before snapshot
    fs.writeFileSync(datadir + '/onchain/k.json', stringify(K))

    var filename = 'Failsafe-' + K.total_blocks + '.tar.gz'

    require('tar').c(
      {
        gzip: true,
        sync: false,
        portable: true,
        noMtime: true,
        file: datadir + '/offchain/' + filename,
        filter: (path, stat) => {
          // must be deterministic
          stat.mtime = null
          stat.atime = null
          stat.ctime = null
          stat.birthtime = null

          // Skip all test data dirs, our offchain db, tools and irrelevant things for the user
          // Todo: use whitelist instead?
          if (
            path.startsWith('./.') ||
            path.match(
              /^\.\/(data[0-9]+|data\/offchain|\.DS_Store|node_modules|wallet\/node_modules|dist|tools)/
            )
          ) {
            return false
          } else {
            return true
          }
        }
      },
      ['.'],
      (_) => {
        if (old_height > 1) {
          // genesis state is stored for analytics and member bootstraping
          fs.unlink(datadir + '/offchain/Failsafe-' + old_height + '.tar.gz')
          l('Removed old snapshot and created ' + filename)
        }
        snapshotHash()
      }
    )
  }

  // we don't want onchain db to be bloated with revealed hashlocks forever, so destroy them
  all.push(
    Hashlock.destroy({
      where: {
        delete_at: K.usable_blocks
      }
    })
  )

  // save final block in offchain db. Required for members, optional for everyone else (aka "pruning" mode)
  // it is fine to delete a block after grace period ~3 months.
  if (me.my_member || !me.prune) {
    all.push(
      Block.create({
        prev_hash: fromHex(prev_hash),
        hash: sha3(header),

        precommits: r(precommits), // pack them in rlp for storage
        header: header,
        ordered_tx_body: ordered_tx_body,

        total_tx: ordered_tx.length,

        // did anything happen in this block?
        meta:
          meta.parsed_tx.length +
            meta.cron.length +
            meta.missed_validators.length >
          0
            ? JSON.stringify(meta)
            : null
      })
    )
  }

  await Promise.all(all)

  if (me.request_reload) {
    gracefulExit('reload requested')
  }

  return true
}