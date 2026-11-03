; benchmark generated from python API
(set-info :status unknown)
(declare-fun q_limit () Int)
(declare-fun q_used () Int)
(declare-fun q_claimed () Bool)
(assert
 (let (($x531 (<= q_used q_limit)))
 (let (($x790 (>= q_used 0)))
 (let (($x491 (> q_limit 0)))
 (and $x491 $x790 $x531)))))
(assert
 (let ((?x899 (+ q_used 1)))
(let ((?x628 (ite (and q_claimed (<= q_used q_limit)) ?x899 q_used)))
(let (($x491 (> q_limit 0)))
(let (($x504 (and $x491 (>= ?x628 0) (<= ?x628 q_limit))))
(not $x504))))))
(check-sat)
