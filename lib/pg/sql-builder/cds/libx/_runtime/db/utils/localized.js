// REVISIT: for subselects in @restrict.where
const _redirectXpr = (xpr, localize) => {
  xpr &&
    xpr.forEach(ele => {
      if (ele.xpr) {
        ele.xpr.forEach(element => {
          redirect(element, localize)
        })

        return
      }

      if (ele.SELECT) {
        redirect(ele.SELECT, localize)
      }
    })
}

const _redirectRef = (ref, localize) => {
  if (ref[0].id) {
    // for views with params
    ref[0].id = localize(ref[0].id)
  } else {
    ref[0] = localize(ref[0])
  }
}

const redirect = (partialCqn, localize) => {
  if (partialCqn.SELECT) {
    redirect(partialCqn.SELECT, localize)
    _redirectXpr(partialCqn.SELECT.where, localize)
    _redirectXpr(partialCqn.SELECT.having, localize)
    _redirectXpr(partialCqn.SELECT.columns, localize)
    return
  }

  if (partialCqn.from && typeof partialCqn.from === 'object') {
    if (partialCqn.from.ref) {
      _redirectRef(partialCqn.from.ref, localize)
    } else {
      redirect(partialCqn.from, localize)
    }

    return
  }

  if (partialCqn.join && typeof partialCqn.join === 'string') {
    partialCqn.args.forEach(arg => {
      if (arg.ref) {
        _redirectRef(arg.ref, localize)
      } else {
        redirect(arg, localize)
      }
    })

    _redirectXpr(partialCqn.on, localize)
    return
  }

  if (partialCqn.SET && partialCqn.SET.op === 'union') {
    partialCqn.SET.args.forEach(arg => {
      redirect(arg, localize)
    })

    return
  }

  if (partialCqn.xpr) {
    partialCqn.xpr.forEach(arg => {
      redirect(arg, localize)
    })
  }
}

module.exports = {
  redirect
}
