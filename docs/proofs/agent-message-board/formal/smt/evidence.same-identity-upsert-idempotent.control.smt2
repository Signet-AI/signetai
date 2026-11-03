; benchmark generated from python API
(set-info :status unknown)
(declare-fun v_key () Int)
(declare-fun v_artifacts () (Array Int Bool))
(assert
 (let ((?x501 (store v_artifacts v_key true)))
(let (($x278 (= (store ?x501 (+ v_key 1) true) ?x501)))
(not $x278))))
(check-sat)
