; benchmark generated from python API
(set-info :status unknown)
(declare-fun q_limit () Int)
(declare-fun q_used () Int)
(assert
 (let (($x790 (>= q_used 0)))
(let (($x491 (> q_limit 0)))
(and $x491 $x790 (<= q_used q_limit)))))
(check-sat)
