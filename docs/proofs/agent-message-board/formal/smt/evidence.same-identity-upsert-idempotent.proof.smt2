; benchmark generated from python API
(set-info :status unknown)
(declare-fun v_key () Int)
(declare-fun v_artifacts () (Array Int Bool))
(assert
 (let ((?x501 (store v_artifacts v_key true)))
(let (($x318 (= (store ?x501 v_key true) ?x501)))
(not $x318))))
(check-sat)
