/* eslint-disable no-unused-vars */
import Uno from 'uno'
import HTMLParser from 'unobuilder-parser'
import cssProps from 'unobuilder-style-to-object'
import * as mutation from '../mutation-types'
import * as utils from '../../utils'
import {
  Labels,
  RootElementTag,
  VoidElements,
  NestedableRules,
  MoveAction,
  ElementOffsetGap,
  ScreenType,
  MouseType,
  AvailableProps
} from '../../const'
import { isEqual } from 'lodash'
import NodeUtils from '../helpers/node-utils'

const defaultDropline = {
  index: 0,
  element: undefined,
  target: undefined,
  position: {
    top: false,
    bottom: false,
    right: false,
    left: false
  },
  offset: {
    top: null,
    bottom: null,
    right: null,
    left: null,
    width: null,
    height: null
  },
  coords: {
    x: 0,
    y: 0
  }
}

const state = {
  prev: [],
  current: [],
  snapshot: [],
  next: [],
  move: {},
  editable: undefined,
  window: undefined,
  selected: null,
  hovered: null,
  lastInserted: null,
  openBreadcrumbs: false,
  dragging: {
    index: 0,
    status: false,
    activeId: null
  },
  dropline: Object.assign({}, defaultDropline)
}

const NodeHelpers = new NodeUtils(state)

const mutations = {
  /**
   * Set owner document of builder
   */
  [mutation.SET_OWNER_WINDOW] (state, win) {
    state.window = win
  },

  /**
   * Apply changes mutation
   * - Insert current state at the end of previous state.
   * - Set current element to the new state after handling the action.
   * - Clear the next state.
   */
  [mutation.APPLY_ELEMENT] (state) {
    const { prev, current, snapshot } = state
    const snapshotObject = utils.CloneObject(snapshot)

    if (!isEqual(snapshotObject, current)) {
      state.prev = [...prev, current]
      state.current = snapshotObject
      state.snapshot = []
      state.next = []
    }
  },

  /**
   * Undo Mutation
   * - Remove the last element from the previous state.
   * - Set current element to the element we removed in the previous step.
   * - Insert the old current state at the beginning of the next state.
   */
  [mutation.UNDO_ELEMENT] (state) {
    const { prev, current, next, selected } = state

    if (prev.length > 1) {
      state.prev = prev.slice(0, prev.length - 1)
      state.current = prev[prev.length - 1]
      state.next = [current, ...next]
      const newSelected = NodeHelpers.getElementObject(selected.id, state.current)
      if (newSelected) {
        state.selected = newSelected
      }
    }
  },

  /**
   * Redo Mutation
   * - Remove the first element from the next state.
   * - Set current element to the element we removed in the previous step.
   * - Insert the old current state at the end of the prev state.
   */
  [mutation.REDO_ELEMENT] (state) {
    const { prev, current, next, selected } = state

    if (next.length > 0) {
      state.prev = [...prev, current]
      state.current = next[0]
      state.next = next.slice(1)
      const newSelected = NodeHelpers.getElementObject(selected.id, state.current)
      if (newSelected) {
        state.selected = newSelected
      }
    }
  },

  /**
   * Save current state
   */
  [mutation.SNAPSHOT_ELEMENT] (state) {
    state.snapshot = utils.CloneObject(state.current)
  },

  /**
   * Add element to current state
   */
  [mutation.ADD_ELEMENT] (state, { object, name, appendTo, index = 0 }) { //
    let element = object

    if (name) {
      element.name = name
    }

    // recursively change node id
    const recursive = obj => {
      if (typeof obj !== 'object') return obj
      const classes = {}

      if (obj[utils.AttrType.KIND] && obj[utils.AttrType.KIND].length > 0) {
        const id = utils.RandomUID()
        obj.id = id
        obj.dataObject.attrs[utils.SelectorAttrId] = id
        obj.dataObject.ref = id.replace(/-/g, '')

        const value = obj[utils.AttrType.KIND]
        classes[utils.GlobalClassName(value)] = true
        if (value === 'row') {
          obj.dataObject.domProps['gutter'] = {}
        }
      }

      const snapshotClass = Object.assign({}, obj.dataObject.class)
      if (Object.keys(classes).length > 0 && obj.kind) {
        obj.dataObject.class = Object.assign(snapshotClass, classes)
      }

      if (obj.childNodes.length > 0) {
        for (let i = 0; i < obj.childNodes.length; i++) {
          recursive(obj.childNodes[i])
        }
      }

      return obj
    }

    element = recursive(element)
    const specialEvents = ['beforeInit', 'afterInit']

    // Register all events that passed
    if ('name' in element) {
      const { events } = Uno.getComponentItem(element.name) || Uno.getBlockItem(element.name)
      Object.keys(events).forEach((eventName) => {
        const fn = events[eventName]
        if (specialEvents.indexOf(eventName) < 0) {
          Uno.on(`${ element.id }:${ eventName }`, fn)
        }
      })
    }

    if (element) {
      state.lastInserted = element.id

      if (!appendTo) {
        index = !index ? state.snapshot.length : index
        state.snapshot.splice(index, 0, element)
      } else {
        const appendEl = NodeHelpers.getElementObject(appendTo, state.snapshot)
        index = !index ? appendEl.childNodes.length : index
        appendEl.childNodes.splice(index, 0, element)
      }
    }

    Uno.emit(`${ element.id }:added`, element)
  },

  /**
   * Remove current element state by id
   */
  [mutation.REMOVE_ELEMENT] (state, id) {
    NodeHelpers.deleteNodeById(id, state.snapshot)
  },

  /**
   * Set selected element
   */
  [mutation.SELECT_ELEMENT] (state, { element, selected }) {
    element.selected = selected
    state.selected = element
  },

  /**
   * Set selected element
   */
  [mutation.HOVER_ELEMENT] (state, element) {
    state.hovered = element
  },

  /**
   * Move element (save cut and copy element state)
   */
  [mutation.MOVE_ELEMENT] (state, payload) {
    state.move = payload
  },

  /**
   * Paste element
   */
  [mutation.DROP_ELEMENT] (state, options) {
    if (options.parentOf) {
      const parent = NodeHelpers.getParentElementObject(options.parentOf, state.snapshot)
      options.id = parent.id
    }

    const dropElement = options && options.id
     ? NodeHelpers.getElementObject(options.id, state.snapshot)
     : state.snapshot

    if (!dropElement || !state.move.element) return

    let index = options && options.index ? options.index : 0
    let srcElement = utils.CloneObject(state.move.element)
    if (state.move.action === MoveAction.COPY) {
      srcElement = utils.ChangeIdDeep(srcElement)
    }

    if (options && options.id) {
      const notVoidElement = !NodeHelpers.isVoidElementById(dropElement.id)
      const canNested = NodeHelpers.isNestedablePair(srcElement.kind, dropElement.kind)
      if (notVoidElement && canNested) {
        NodeHelpers.insertChildNodesByIndex(dropElement, srcElement, index)
      }
    } else {
      index = index === 0 ? dropElement.length : index
      dropElement.splice(index, 0, srcElement)
    }

    state.dropline = Object.assign({}, defaultDropline)
  },

  /**
   * Enable or disable editable content
   */
  [mutation.EDIT_CONTENT] (state, editableNode) {
    const element = NodeHelpers.getElementObjectByNode(editableNode, state.snapshot)
    if (element && element.editable) {
      element.dataObject.attrs.contenteditable = true
      setTimeout(() => NodeHelpers.setCursorPosition(false)(editableNode), 0)
    }
  },

  /**
   * Toggle breadcrumbs in element selector tools
   */
  [mutation.TOGGLE_BREADCRUMB] (state, toggle) {
    toggle = typeof toggle === 'undefined' ? !state.openBreadcrumbs : toggle
    state.openBreadcrumbs = toggle
  },

  /**
   * Set window scroll Y value
   */
  [mutation.SET_WINDOW_SCROLL] (state, value) {
    if (state.window) {
      if (typeof value === 'string') {
        const [operator, intvalue] = value.split('')

        switch (operator) {
          case '+':
            value = state.window.scrollY + parseInt(intvalue)
            break

          case '-':
            value = state.window.scrollY - parseInt(intvalue)
            break
        }
      }

      state.window.scrollTo(state.window.scrollX, value)
    }
  },

  [mutation.TOGGLE_DRAG_ELEMENT] (state, status) {
    state.dragging.status = status === undefined
      ? !state.dragging.status
      : status
  },

  [mutation.SET_ACTIVE_ELEMENT] (state, { id, force = false }) {
    let index = 0
    let elementId = id
    if (!force) {
      elementId = NodeHelpers.getRealElement(id).id
      index = NodeHelpers.getIndexFromParent(elementId)
    }

    state.dragging.index = index
    state.dragging.activeId = elementId
  },

  [mutation.CLEAR_ACTIVE_ELEMENT] (state, id) {
    state.dragging.activeId = null
  },

  [mutation.SET_DROPLINE] (state, options) {
    state.dropline = Object.assign(defaultDropline, options)
  },

  [mutation.RESET_DROPLINE] (state) {
    state.dropline = defaultDropline
  },

  [mutation.SET_ELEMENT_STYLE] (state, { element, snapshot, screenSize, mouseState, disabled, styles }) {
    const fromElement = snapshot ? state.snapshot : state.current
    const el = element ? element.id : state.selected.id

    const selected = NodeHelpers.getElementObject(el, fromElement)
    selected.cssProperties[screenSize][mouseState] = cssProps(styles)
  },

  [mutation.SET_ATTRS_ELEMENT] (state, payload) {
    const { id, name, value } = payload
    const element = NodeHelpers.getElementObject(id)
    element.dataObject.attrs[name] = value
  },

  [mutation.REMOVE_ATTRS_ELEMENT] (state, payload) {
    const { id, name } = payload
    const element = NodeHelpers.getElementObject(id)

    if (element.dataObject.attrs[name]) {
      element.dataObject.attrs[name] = false
    }
  },

  [mutation.SWITCH_EDITABLE] (state, id) {
    if (id) {
      const element = NodeHelpers.getElementObject(id)
      if (!element) {
        state.editable = undefined
        return
      }
    }

    state.editable = id
  },

  [mutation.SAVE_EDITABLE] (state) {
    const element = NodeHelpers.getElementObject(state.editable)
    const editableNode = NodeHelpers.getElementNodeById(state.editable)

    const wrapper = document.createElement(element.tagName)
    wrapper.innerHTML = editableNode.outerHTML

    const newChildNodes = new HTMLParser(wrapper.innerHTML)
    element.childNodes = newChildNodes.childNodes
  }
}

const actions = {
  /**
   * Set owner window
   */
  setOwnerWindow ({ commit }, win) {
    commit(mutation.SET_OWNER_WINDOW, win)
  },

  /**
   * Undo Action
   * @param  {Function} store.commit
   * @return {void}
   */
  undoElement ({ commit, state, dispatch }) {
    if (state.prev.length > 1) {
      commit(mutation.UNDO_ELEMENT)

      // Select root element
      commit(mutation.SET_WINDOW_SCROLL, '+1')
      commit(mutation.HOVER_ELEMENT, null)
      commit(mutation.SET_WINDOW_SCROLL, '-1')
    }
  },

  /**
   * Redo Action
   * @param  {Function} store.commit
   * @return {void}
   */
  redoElement ({ commit, dispatch }) {
    if (state.next.length > 0) {
      commit(mutation.REDO_ELEMENT)
      // Select root element
      commit(mutation.SET_WINDOW_SCROLL, '+1')
      commit(mutation.HOVER_ELEMENT, null)
      commit(mutation.SET_WINDOW_SCROLL, '-1')
    }
  },

  /**
   * Add Element to the current state
   * @param {Function} store.commit
   * @param {String} options.markupText
   * @param {String} options.appendTo
   * @return {void}
   */
  addElement ({ commit, state, dispatch }, options) {
    commit(mutation.SET_WINDOW_SCROLL, '+1')
    commit(mutation.SNAPSHOT_ELEMENT)
    commit(mutation.ADD_ELEMENT, options)
    commit(mutation.APPLY_ELEMENT)
    commit(mutation.SET_WINDOW_SCROLL, '-1')
    dispatch('resetDropline')
    return options.object
  },

  /**
   * Remove Element
   * @param  {Function} store.commit
   * @param  {String} id
   * @return {void}
   */
  removeElement ({ commit, state }, id) {
    const element = NodeHelpers.getRequiredParentElement(id, state.current) || NodeHelpers.getElementObject(id, state.current)
    const nextElement = NodeHelpers.getSiblingElement(element.id, state.current)

    commit(mutation.SNAPSHOT_ELEMENT)
    commit(mutation.REMOVE_ELEMENT, element.id)
    commit(mutation.APPLY_ELEMENT)

    return nextElement
  },

  /**
   * Copy and Cut actions in memory
   * @param  {Function} options.commit
   * @param  {Function} options.state
   * @param  {String} options.action
   * @param  {String} options.id
   * @return {void}
   */
  moveElement ({ commit, state, dispatch }, { action, id, appendTo, index = 0 }) {
    commit(mutation.SNAPSHOT_ELEMENT)
    const srcElement = NodeHelpers.getRequiredParentElement(id, state.snapshot) || NodeHelpers.getElementObject(id, state.snapshot)
    const appendSrcElement = NodeHelpers.getRequiredParentElement(appendTo, state.snapshot) || NodeHelpers.getElementObject(appendTo, state.snapshot)

    // check if have same parent
    if (srcElement.id === appendSrcElement.id) {
      return false
    }

    if (srcElement) {
      commit(mutation.MOVE_ELEMENT, {
        action,
        element: srcElement
      })

      if (action === MoveAction.CUT) {
        commit(mutation.REMOVE_ELEMENT, srcElement.id)
      }

      commit(mutation.DROP_ELEMENT, {
        id: appendTo,
        index
      })

      commit(mutation.APPLY_ELEMENT)

      dispatch('resetDropline')

      return srcElement
    }
  },

  /**
   * Duplicate
   * @param  {Function} options.commit
   * @param  {Function} options.state
   * @param  {String} options.action
   * @param  {String} options.id
   * @return {void}
   */
  duplicateElement ({ commit, state }, id) {
    commit(mutation.SNAPSHOT_ELEMENT)
    const srcElement = NodeHelpers.getElementObject(id, state.snapshot)

    if (srcElement) {
      const index = NodeHelpers.getIndexFromParent(id)
      const dupeElement = utils.CloneObject(srcElement)
      commit(mutation.MOVE_ELEMENT, {
        action: MoveAction.COPY,
        element: dupeElement
      })
      commit(mutation.DROP_ELEMENT, {
        index,
        parentOf: id
      })
      commit(mutation.APPLY_ELEMENT)
      return dupeElement
    }
  },

  /**
   * Drop element to another element with given index
   * @param  {Function} options.commit
   * @param  {Object} options
   * @return {void}
   */
  dropElement ({ commit }, options) {
    commit(mutation.SNAPSHOT_ELEMENT)
    commit(mutation.DROP_ELEMENT, options)
    commit(mutation.APPLY_ELEMENT)
  },

  /**
   * Select element by ID
   * @param  {Function} options.commit
   * @param  {Object}   options.state
   * @param  {String}   id
   * @return {void}
   */
  selectElement ({ commit, state, dispatch }, id) {
    commit(mutation.SET_WINDOW_SCROLL, '+1')

    if (!id && state.editable === id) {
      return
    }

    if (id.tagName) {
      id = utils.GetNodeId(id)
    }

    const element = NodeHelpers.getElementObject(id)
    if (element && element.kind) {
      if (state.editable && state.editable !== id) {
        dispatch('saveEditable')
        commit(mutation.REMOVE_ATTRS_ELEMENT, {
          id: state.editable,
          name: 'contenteditable'
        })
        commit(mutation.SWITCH_EDITABLE)
      }

      commit(mutation.SELECT_ELEMENT, {
        element,
        selected: true
      })
    }

    // Hide all breadcrumbs again
    commit(mutation.TOGGLE_BREADCRUMB, false)
    commit(mutation.SET_WINDOW_SCROLL, '-1')

    return element
  },

  hoverElement ({ commit }, id) {
    if (!id) {
      return
    }

    if (id.tagName) {
      id = utils.GetNodeId(id)
    }

    const element = NodeHelpers.getElementObject(id)
    if (element && element.kind) {
      commit(mutation.HOVER_ELEMENT, element)
    }
  },

  toggleBreadcrumbs ({ commit }) {
    commit(mutation.TOGGLE_BREADCRUMB)
  },

  showBreadcrumbs ({ commit }) {
    commit(mutation.TOGGLE_BREADCRUMB, true)
  },

  hideBreadcrumbs ({ commit }) {
    commit(mutation.TOGGLE_BREADCRUMB, false)
  },

  refreshScroll ({ commit }) {
    commit(mutation.SET_WINDOW_SCROLL, '+1')
    commit(mutation.SET_WINDOW_SCROLL, 0)
  },
  toggleDragElement ({ commit }, status) {
    commit(mutation.TOGGLE_DRAG_ELEMENT, status)
  },
  enableDragElement ({ commit }, option) {
    commit(mutation.TOGGLE_DRAG_ELEMENT, true)
    commit(mutation.SET_ACTIVE_ELEMENT, option)
  },

  disableDragElement ({ commit }) {
    commit(mutation.TOGGLE_DRAG_ELEMENT, false)
    commit(mutation.CLEAR_ACTIVE_ELEMENT)
  },

  setDropline ({ commit }, options) {
    commit(mutation.SET_DROPLINE, options)
  },

  resetDropline ({ commit }) {
    commit(mutation.RESET_DROPLINE)
  },

  setElementStyle ({ state, commit, dispatch }, payload) {
    const object = Object.assign({
      element: undefined,
      mouseState: Labels.MOUSE_STATE_NONE,
      disabled: false,
      snapshot: true
    }, payload)

    if (object.snapshot) {
      commit(mutation.SNAPSHOT_ELEMENT)
    }

    commit(mutation.SET_ELEMENT_STYLE, object)

    if (object.snapshot) {
      commit(mutation.APPLY_ELEMENT)
    }

    dispatch('reselectElement')
  },

  reselectElement ({ commit }) {
    if (!state.selected) return

    const selected = NodeHelpers.getElementObject(state.selected.id)
    if (selected) {
      commit(mutation.SELECT_ELEMENT, {
        element: selected,
        selected: true
      })
    }
  },

  setDefaultStyle ({ getters, dispatch }, object) {
    const { iframeWindow, screenSize, globalProperties } = getters

    if (iframeWindow) {
      const recursive = elObject => {
        if (typeof elObject !== 'object') return elObject
        const { id, kind } = elObject
        const element = NodeHelpers.getElementNodeById(id)
        let computedStyle = {}
        if (element) {
          computedStyle = iframeWindow.getComputedStyle(element)
        }
        const styles = {}

        AvailableProps.forEach(propName => {
          if (computedStyle[propName] && !object.cssProperties[screenSize].none[propName]) {
            styles[propName] = computedStyle[propName]
          }
        })

        const newStyle = {
          element: elObject,
          screenSize,
          snapshot: false,
          styles: cssProps(styles)
        }

        dispatch('setGlobalStyle', newStyle)
          .then(globalObject => {
            if (globalProperties[screenSize][kind]) {
              const newStyles = {}
              AvailableProps.forEach(propName => {
                if (!object.cssProperties[screenSize].none[propName]) {
                  newStyles[propName] = globalProperties[screenSize][kind].none[propName].value
                }
              })
              const newProps = Object.assign({}, newStyle, { styles })
              dispatch('setElementStyle', newProps)
            } else {
              dispatch('setElementStyle', newStyle)
            }
          })

        if (elObject.childNodes.length > 0) {
          for (let i = 0; i < elObject.childNodes.length; i++) {
            const child = elObject.childNodes[i]
            recursive(child)
          }
        }
      }

      recursive(object)
    }
  },

  setAttrsElement ({ commit }, payload) {
    if (payload.id) {
      commit(mutation.SET_ATTRS_ELEMENT, payload)
    }
  },

  removeAttrsElement ({ commit }, payload) {
    if (payload.id) {
      commit(mutation.REMOVE_ATTRS_ELEMENT, payload)
    }
  },

  editContent ({ commit, dispatch }, id) {
    if (id) {
      commit(mutation.SET_ATTRS_ELEMENT, {
        id,
        name: 'contenteditable',
        value: true
      })
      commit(mutation.SWITCH_EDITABLE, id)

      const editableNode = NodeHelpers.getElementNodeById(id)
      setTimeout(() => NodeHelpers.setCursorPosition(false)(editableNode), 0)
    }
  },

  saveEditable ({ commit }) {
    commit(mutation.SAVE_EDITABLE)
  }

}

const getters = {
  /**
   * Get iframe window
   * @param {Object} state
   * @return {Object}
   */
  iframeWindow: state => state.window,

  /**
   * Get iframe document
   * @param {Object} state
   * @return {Object}
   */
  iframeDocument (state) {
    if (state.window) return state.window.document
  },

  /**
   * Get iframe document
   * @param {Object} state
   * @return {Object}
   */
  iframeBody (state) {
    if (state.window) return state.window.document.body
  },

  iframeOffset (state) {
    if (state.window) return state.window.frameElement.getBoundingClientRect()
  },

  /**
   * Element list
   * @param  {Object} state
   * @return {Object}
   */
  elements: state => state.current,

  /**
   * Selected Element
   * @param  {Object} state
   * @return {Object}
   */
  selectedElement: state => state.selected,

  /**
   * Hovered Element
   * @param  {Object} state
   * @return {Object}
   */
  hoveredElement: state => state.hovered,

  /**
   * Block add placement offset
   * @param {Object} state
   * @return {Object}
   */
  blockPosition (state, rootState) {
    let position = 0

    if (!state.hovered) {
      return position
    }

    const element = NodeHelpers.getRootElement(state.hovered.id)

    if (!element) {
      return position
    }

    const { canvasScroll } = rootState
    let { top, height } = element.getBoundingClientRect()

    if (element.getAttribute(RootElementTag)) {
      height = 0

      const elementObject = NodeHelpers.getElementObjectByNode(element, state.current)
      if (elementObject && elementObject.childNodes.length > 0) {
        const last = elementObject.childNodes.slice().pop()
        const lastElement = NodeHelpers.getElementNodeById(last.id)
        if (lastElement) {
          const lastBounds = lastElement.getBoundingClientRect()
          top = lastBounds.top
          height = lastBounds.height
        }
      }
    }

    if (canvasScroll.top) {
      top += Math.abs(canvasScroll.top)
    }

    position = height + top
    return position
  },

  rootElement (state) {
    if (state.window && state.window.document) {
      const element = state.window.document.querySelector(`[${ utils.SelectorAttrId }][${ RootElementTag }]`)
      return NodeHelpers.getElementObjectByNode(element, state.current)
    }

    return {}
  },

  /**
   * Block index
   **/
  blockIndex () {
    let index = 0

    if (!state.hovered) {
      return index
    }

    const element = NodeHelpers.getRootElement(state.hovered.id)
    if (element) {
      if (element.getAttribute(RootElementTag)) {
        const elementObject = NodeHelpers.getElementObjectByNode(element, state.current)
        if (elementObject && elementObject.childNodes.length > 0) {
          index = elementObject.childNodes.length
        }

        return index
      }

      const elementId = utils.GetNodeId(element)
      const parentElement = NodeHelpers.getParentElement(elementId)
      if (parentElement) {
        const childNodes = parentElement.childNodes
        for (let i = 0; i < childNodes.length; i++) {
          if (utils.GetNodeId(childNodes[i]) === elementId) {
            index = i
          }
        }
      }
      index++
    }

    return index
  },

  /**
   * Breadcrumbs on selected element
   * @return {Array}
   */
  breadcrumbs (state) {
    const breadcrumbs = []

    if (state.selected) {
      // Get current breacrumb
      const { id, label } = state.selected
      breadcrumbs.push({ id, label })

      // Get parent breadcrumb
      const parent = NodeHelpers.getParentElementObject(id, state.current)
      if (parent) {
        breadcrumbs.push({ id: parent.id, label: parent.label })
      }

      // Get grandparent
      const grandParent = parent ? NodeHelpers.getParentElementObject(parent.id, state.current) : null
      if (grandParent) {
        breadcrumbs.push({ id: grandParent.id, label: grandParent.label })
      }
    }

    return breadcrumbs.reverse()
  },

  /**
   * Single breadcrumb on hovered element
   */
  breadcrumb (state, getters, rootState) {
    let breadcrumb = {}

    if (state.hovered) {
      const { id, label } = state.hovered
      breadcrumb = { id, label }

      if ((rootState.components.dragging.status || state.dragging.status) && state.dropline.position.bottom) {
        const parent = NodeHelpers.getRealParent(state.hovered.id)
        if (parent) {
          breadcrumb = { id: parent.id, label: parent.label }
        }
      }
    }

    return breadcrumb
  },

  /**
   * Open breadcrumbs in selector elements
   */
  openBreadcrumbs: state => state.openBreadcrumbs,

  /**
   * Check wheter selected element is void element
   * @param  {Object}  state
   * @return {Boolean}
   */
  isVoidElement (state) {
    if (state.selected) {
      return NodeHelpers.isVoidElementById(state.selected.id)
    }
  },

  /**
   * Get state dragging of element
   * @param {Object} state
   */
  elementDragging: state => state.dragging.status,

  dropline (state, getter, rootState) {
    const dropline = Object.assign({}, state.dropline)
    if (!state.window) {
      return
    }

    const iframeOffset = state.window.frameElement.getBoundingClientRect()
    const canvasScroll = getter.canvasScroll

    if (dropline.position.bottom) {
      const parent = NodeHelpers.getRealParent(dropline.element)
      if (parent) {
        const { left, width } = NodeHelpers.getElementNodeById(parent.id).getBoundingClientRect()
        dropline.offset.width = width
        dropline.offset.left = left + iframeOffset.left
        dropline.target = parent.id
        dropline.index = parent.childNodes.length
      }
    }

    if (dropline.target) {
      const currentElement = NodeHelpers.getElementObject(dropline.target)
      const childsLength = currentElement.childNodes.length
      const droplines = []
      if (childsLength > 1) {
        for (let i = 0; i < childsLength; i++) {
          const childEl = NodeHelpers.getElementNodeById(currentElement.childNodes[i].id)
          if (childEl) {
            const { top, left, width, height } = childEl.getBoundingClientRect()
            droplines.push({
              id: currentElement.childNodes[i].id,
              top,
              left,
              width,
              height
            })
          }
        }

        const droplineY = dropline.coords.y + canvasScroll.top
        const gap = ElementOffsetGap * 5
        const foundDropline = droplines.filter(item => {
          const mid = item.top
          const top = mid - gap
          const btm = mid + gap
          return top < droplineY && btm > droplineY
        })

        if (foundDropline.length > 0) {
          const newObj = [...foundDropline].slice().pop()
          dropline.offset.width = newObj.width
          dropline.offset.left = newObj.left + iframeOffset.left
          if (!dropline.position.bottom) {
            dropline.offset.top = newObj.top + iframeOffset.top - (gap / 4) + 4
          } else {
            dropline.offset.left += gap / 4
            dropline.offset.width -= gap / 2
          }
          dropline.index = NodeHelpers.getIndexFromParent(newObj.id)
        }
      }
    }

    const parentDragActive = NodeHelpers.getRealParent(state.dragging.activeId)
    if (parentDragActive && dropline.target === parentDragActive.id) {
      if (dropline.index > state.dragging.index) {
        dropline.index--
      }
    }

    return dropline
  },

  elementStyles (state, getters) {
    if (state.selected && state.window) {
      const element = state.window.document.querySelector(utils.SelectorId(state.selected.id))

      const computedStyle = state.window.getComputedStyle(element)
      const nativeProps = {}

      for (const key in computedStyle) {
        const hasProperty = computedStyle.hasOwnProperty(key)
        const style = computedStyle[key]
        if (hasProperty && style !== '' && isNaN(parseInt(key))) {
          nativeProps[key] = computedStyle[key]
        }
      }
      const breakpointStore = getters.screenSize
      const properties = Object.assign({}, state.selected.cssProperties)

      const getStyles = mousestateStore => {
        const breakpoint = Object.values(ScreenType)
        const mousestate = Object.values(MouseType)
        let breakpointIndex = breakpoint.indexOf(breakpointStore)
        let mousestateIndex = mousestate.indexOf(mousestateStore)
        let cssProperties = {}

        for (const propName in nativeProps) {
          breakpointIndex = breakpoint.indexOf(breakpointStore)
          while (true) {
            const currentScreensize = breakpoint[breakpointIndex]
            mousestateIndex = mousestate.indexOf(mousestateStore)
            while (true) {
              const currentMouseState = mousestate[mousestateIndex]
              const currentProps = properties[currentScreensize][currentMouseState]
              const inProperties = propName in currentProps
              if (inProperties) {
                const validProps = currentProps[propName].value && currentProps[propName].disabled !== true
                const inCssProperties = propName in cssProperties

                if (validProps && !inCssProperties) {
                  cssProperties[propName] = currentProps[propName].value
                }
              }

              if (mousestateIndex === 0) break
              if (mousestateIndex > 0 && mousestateIndex !== 1) {
                mousestateIndex = 0
              } else {
                mousestateIndex--
              }
            }
            if (breakpointIndex === 0) break
            breakpointIndex--
          }
        }

        cssProperties = Object.assign(nativeProps, cssProperties)
        return cssProperties
      }

      return {
        get none () {
          return getStyles(MouseType.NONE)
        },

        get hover () {
          return getStyles(MouseType.HOVER)
        },

        get active () {
          return getStyles(MouseType.ACTIVE)
        },

        get focus () {
          return getStyles(MouseType.FOCUS)
        }
      }
    }

    return {
      none: {},
      hover: {},
      active: {},
      focus: {}
    }
  },

  localCSS (state) {
    const getStylesheets = elements => {
      let stylesheets = []

      elements.forEach(element => {
        if (typeof element !== 'string') {
          if (element.childNodes.length > 0) {
            stylesheets = stylesheets.concat(getStylesheets(element.childNodes))
          }

          const selector = utils.SelectorId(element.id)
          for (const breakpoint in element.cssProperties) {
            const properties = element.cssProperties[breakpoint]
            if (Object.keys(properties).length > 0) {
              const data = {
                selector,
                breakpoint,
                properties
              }
              stylesheets.push(data)
            }
          }
        }
      })
      return stylesheets
    }

    return getStylesheets(state.current)
  },

  elementHelpers () {
    return NodeHelpers
  },

  editable (state) {
    return state.editable
  },

  lastInsertedElement (state) {
    return state.lastInserted
  },

  textToolbarOffset (state, getters) {
    if (state.selected && state.window) {
      const node = NodeHelpers.getElementNodeById(state.selected.id)
      const { left: nodeLeft, top: nodeTop } = node.getBoundingClientRect()

      return {
        left: nodeLeft + 30,
        top: nodeTop
      }
    }

    return {}
  }
}

export default {
  state,
  actions,
  getters,
  mutations
}
